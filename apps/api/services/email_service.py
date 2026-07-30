import smtplib
from email.mime.text import MIMEText
from email.mime.multipart import MIMEMultipart
from typing import Optional
import boto3
from botocore.exceptions import ClientError
from ..config import settings
from .email_config import load_mail_config


def email_logo_url() -> Optional[str]:
    """Absolute URL of the site's custom logo for use in an email body, or
    None when no logo is configured.

    Deliberately NOT `proxy_url_for` (routers/hls_proxy.py): that returns a
    *relative*, token-authenticated URL that expires after 24 hours. Neither
    works in an email -- there is no current page for a relative URL to
    resolve against, and a 24h expiry breaks the image in every email older
    than a day. `/site-settings/logo-image` is unauthenticated and
    non-expiring for exactly this reason.

    `frontend_url` + "/api" is how the browser reaches this API in this
    deployment (Traefik routes the /api prefix to the api container) -- the
    same construction app/layout.tsx uses for the favicon.

    Uses logo_light_s3_key only: email bodies are read on a white
    background. Returning None (rather than a URL that 404s) is what lets
    callers omit the <img> entirely instead of showing a broken-image icon.
    """
    # Imported lazily to keep this module import-light for the Celery
    # workers, and to avoid a models <-> services import cycle.
    from ..database import SessionLocal
    from ..models.site_settings import SiteSettings

    db = SessionLocal()
    try:
        site_settings = db.query(SiteSettings).first()
        has_logo = bool(site_settings and site_settings.logo_light_s3_key)
    except Exception as e:
        # A branding lookup must never be the reason an email fails to send.
        print(f"Could not resolve email logo: {e}")
        return None
    finally:
        db.close()

    if not has_logo:
        return None
    return f"{settings.frontend_url}/api/site-settings/logo-image"


def _logo_img_tag() -> str:
    """A centered <img> for the top of an email body, or "" if no logo is
    configured. Inline styles only -- email clients strip <style> blocks."""
    url = email_logo_url()
    if not url:
        return ""
    return (
        '<div style="text-align: center; margin-bottom: 24px;">'
        f'<img src="{url}" alt="" '
        'style="max-height: 48px; max-width: 220px; border: 0;" />'
        "</div>"
    )


class EmailService:
    """
    Email service that supports both AWS SES and standard SMTP.
    Auto-detects based on mail_provider setting in config.
    """
    
    def __init__(self):
        # Resolved per instance from the DB singleton, falling back to env
        # vars field-by-field (services/email_config.py). Note the module
        # still exports a long-lived `email_service` singleton at the bottom
        # of this file -- that one caches whatever config existed when the
        # process started, which is why `refresh()` exists and why the
        # settings-test endpoint constructs its own EmailService.
        self.config = load_mail_config()
        self.provider = self.config.provider
        self.from_address = self.config.from_address
        self.from_name = self.config.from_name

    def refresh(self) -> None:
        """Re-read configuration. Called after an admin saves new settings
        so a running worker doesn't keep using stale credentials until it
        restarts."""
        self.__init__()

    def _get_ses_client(self):
        """Create AWS SES client."""
        return boto3.client(
            "ses",
            aws_access_key_id=self.config.aws_access_key_id,
            aws_secret_access_key=self.config.aws_secret_access_key,
            region_name=self.config.aws_region,
        )
    
    def _send_via_ses(
        self,
        to_email: str,
        subject: str,
        html_body: str,
        text_body: Optional[str] = None,
    ) -> bool:
        """Send email via AWS SES."""
        if not self.config.aws_access_key_id or not self.config.aws_secret_access_key:
            raise ValueError("AWS SES credentials not configured")
        
        ses = self._get_ses_client()
        
        body = {"Html": {"Charset": "UTF-8", "Data": html_body}}
        if text_body:
            body["Text"] = {"Charset": "UTF-8", "Data": text_body}
        
        try:
            ses.send_email(
                Source=f"{self.from_name} <{self.from_address}>",
                Destination={"ToAddresses": [to_email]},
                Message={
                    "Subject": {"Charset": "UTF-8", "Data": subject},
                    "Body": body,
                },
            )
            return True
        except ClientError as e:
            print(f"SES error: {e.response['Error']['Message']}")
            return False
    
    def _send_via_smtp(
        self,
        to_email: str,
        subject: str,
        html_body: str,
        text_body: Optional[str] = None,
    ) -> bool:
        """Send email via SMTP server."""
        if not self.config.smtp_host:
            raise ValueError("SMTP host not configured")
        
        msg = MIMEMultipart("alternative")
        msg["Subject"] = subject
        msg["From"] = f"{self.from_name} <{self.from_address}>"
        msg["To"] = to_email
        
        if text_body:
            msg.attach(MIMEText(text_body, "plain"))
        msg.attach(MIMEText(html_body, "html"))
        
        try:
            if self.config.smtp_use_tls:
                server = smtplib.SMTP(self.config.smtp_host, self.config.smtp_port)
                server.starttls()
            else:
                server = smtplib.SMTP_SSL(self.config.smtp_host, self.config.smtp_port)

            if self.config.smtp_user and self.config.smtp_password:
                server.login(self.config.smtp_user, self.config.smtp_password)
            
            server.sendmail(self.from_address, [to_email], msg.as_string())
            server.quit()
            return True
        except Exception as e:
            print(f"SMTP error: {e}")
            return False
    
    def send_email(
        self,
        to_email: str,
        subject: str,
        html_body: str,
        text_body: Optional[str] = None,
    ) -> bool:
        """
        Send email using configured provider (SES or SMTP).
        
        Args:
            to_email: Recipient email address
            subject: Email subject
            html_body: HTML content of the email
            text_body: Optional plain text fallback
            
        Returns:
            True if sent successfully, False otherwise
        """
        if self.provider == "ses":
            return self._send_via_ses(to_email, subject, html_body, text_body)
        elif self.provider == "smtp":
            return self._send_via_smtp(to_email, subject, html_body, text_body)
        else:
            raise ValueError(f"Unknown mail provider: {self.provider}")
    
    def send_invite_email(self, to_email: str, inviter_name: str, org_name: str, invite_link: str) -> bool:
        """Send organization invite email."""
        subject = f"You've been invited to join {org_name} on FreeFrame"
        html_body = f"""
        <html>
        <body style="font-family: Arial, sans-serif; line-height: 1.6; color: #333;">
            {_logo_img_tag()}
            <h2>You're invited!</h2>
            <p><strong>{inviter_name}</strong> has invited you to join <strong>{org_name}</strong> on FreeFrame.</p>
            <p>
                <a href="{invite_link}" 
                   style="display: inline-block; padding: 12px 24px; background-color: #4F46E5; 
                          color: white; text-decoration: none; border-radius: 6px;">
                    Accept Invitation
                </a>
            </p>
            <p style="color: #666; font-size: 14px;">
                If you didn't expect this invitation, you can ignore this email.
            </p>
        </body>
        </html>
        """
        text_body = f"{inviter_name} has invited you to join {org_name} on FreeFrame. Click here to accept: {invite_link}"
        return self.send_email(to_email, subject, html_body, text_body)
    
    def send_comment_notification(
        self, 
        to_email: str, 
        commenter_name: str, 
        asset_name: str, 
        comment_preview: str,
        asset_link: str
    ) -> bool:
        """Send notification when someone comments on an asset."""
        subject = f"New comment on {asset_name}"
        html_body = f"""
        <html>
        <body style="font-family: Arial, sans-serif; line-height: 1.6; color: #333;">
            {_logo_img_tag()}
            <h2>New Comment</h2>
            <p><strong>{commenter_name}</strong> commented on <strong>{asset_name}</strong>:</p>
            <blockquote style="border-left: 3px solid #4F46E5; padding-left: 12px; color: #555;">
                {comment_preview}
            </blockquote>
            <p>
                <a href="{asset_link}" 
                   style="display: inline-block; padding: 12px 24px; background-color: #4F46E5; 
                          color: white; text-decoration: none; border-radius: 6px;">
                    View Comment
                </a>
            </p>
        </body>
        </html>
        """
        text_body = f"{commenter_name} commented on {asset_name}: {comment_preview}\n\nView: {asset_link}"
        return self.send_email(to_email, subject, html_body, text_body)
    
    def send_mention_notification(
        self,
        to_email: str,
        mentioner_name: str,
        asset_name: str,
        comment_preview: str,
        asset_link: str
    ) -> bool:
        """Send notification when someone mentions a user."""
        subject = f"{mentioner_name} mentioned you on {asset_name}"
        html_body = f"""
        <html>
        <body style="font-family: Arial, sans-serif; line-height: 1.6; color: #333;">
            {_logo_img_tag()}
            <h2>You were mentioned</h2>
            <p><strong>{mentioner_name}</strong> mentioned you on <strong>{asset_name}</strong>:</p>
            <blockquote style="border-left: 3px solid #4F46E5; padding-left: 12px; color: #555;">
                {comment_preview}
            </blockquote>
            <p>
                <a href="{asset_link}" 
                   style="display: inline-block; padding: 12px 24px; background-color: #4F46E5; 
                          color: white; text-decoration: none; border-radius: 6px;">
                    View Comment
                </a>
            </p>
        </body>
        </html>
        """
        text_body = f"{mentioner_name} mentioned you on {asset_name}: {comment_preview}\n\nView: {asset_link}"
        return self.send_email(to_email, subject, html_body, text_body)
    
    def send_assignment_notification(
        self,
        to_email: str,
        assigner_name: str,
        asset_name: str,
        due_date: Optional[str],
        asset_link: str
    ) -> bool:
        """Send notification when user is assigned to review an asset."""
        due_text = f" (due {due_date})" if due_date else ""
        subject = f"You've been assigned to review {asset_name}{due_text}"
        html_body = f"""
        <html>
        <body style="font-family: Arial, sans-serif; line-height: 1.6; color: #333;">
            {_logo_img_tag()}
            <h2>New Assignment</h2>
            <p><strong>{assigner_name}</strong> has assigned you to review <strong>{asset_name}</strong>.</p>
            {"<p><strong>Due date:</strong> " + due_date + "</p>" if due_date else ""}
            <p>
                <a href="{asset_link}" 
                   style="display: inline-block; padding: 12px 24px; background-color: #4F46E5; 
                          color: white; text-decoration: none; border-radius: 6px;">
                    Review Asset
                </a>
            </p>
        </body>
        </html>
        """
        text_body = f"{assigner_name} assigned you to review {asset_name}.{' Due: ' + due_date if due_date else ''}\n\nView: {asset_link}"
        return self.send_email(to_email, subject, html_body, text_body)
    
    def send_approval_notification(
        self,
        to_email: str,
        reviewer_name: str,
        asset_name: str,
        status: str,  # "approved" or "rejected"
        note: Optional[str],
        asset_link: str
    ) -> bool:
        """Send notification when an asset is approved or rejected."""
        status_emoji = "✅" if status == "approved" else "❌"
        subject = f"{status_emoji} {asset_name} has been {status}"
        html_body = f"""
        <html>
        <body style="font-family: Arial, sans-serif; line-height: 1.6; color: #333;">
            {_logo_img_tag()}
            <h2>Asset {status.title()}</h2>
            <p><strong>{reviewer_name}</strong> has <strong>{status}</strong> <strong>{asset_name}</strong>.</p>
            {"<p><strong>Note:</strong> " + note + "</p>" if note else ""}
            <p>
                <a href="{asset_link}" 
                   style="display: inline-block; padding: 12px 24px; background-color: #4F46E5; 
                          color: white; text-decoration: none; border-radius: 6px;">
                    View Asset
                </a>
            </p>
        </body>
        </html>
        """
        text_body = f"{reviewer_name} {status} {asset_name}.{' Note: ' + note if note else ''}\n\nView: {asset_link}"
        return self.send_email(to_email, subject, html_body, text_body)


# Singleton instance
email_service = EmailService()
