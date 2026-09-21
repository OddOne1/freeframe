"""
Celery tasks for sending emails asynchronously.

Queues:
- email_high: Magic codes, invites (immediate)
- email_low: Mentions, comments, shares (can be slightly delayed)
"""
from datetime import datetime
from pathlib import Path
from typing import Optional
from celery import shared_task
from jinja2 import Environment, FileSystemLoader

# Setup Jinja2 template environment
TEMPLATE_DIR = Path(__file__).parent.parent / "templates"
jinja_env = Environment(
    loader=FileSystemLoader(str(TEMPLATE_DIR)),
    autoescape=True,
)


def render_template(template_name: str, **context) -> str:
    """Render an email template with context."""
    context.setdefault("year", datetime.now().year)
    if "logo_url" not in context:
        # The site's custom logo, resolved once here so every template gets
        # it for free via base.html's header instead of each task passing it
        # through. None when no logo is configured -- base.html then keeps
        # the plain "FreeFrame" wordmark. Imported inline, same as
        # _send_email below, to avoid circular imports.
        from ..services.email_service import email_logo_url
        context["logo_url"] = email_logo_url()
    template = jinja_env.get_template(template_name)
    return template.render(**context)


def _send_email(to_email: str, subject: str, html_body: str, text_body: Optional[str] = None) -> bool:
    """Send email using the email service.

    Constructs a fresh EmailService per send rather than using the module
    singleton: mail settings are now admin-editable at runtime, and a
    long-lived worker holding config resolved at import time would keep
    using stale credentials until the next deploy. The extra cost is one
    small indexed read against a single-row table, against an SMTP/SES
    round trip.
    """
    # Import here to avoid circular imports
    from ..services.email_service import EmailService
    return EmailService().send_email(to_email, subject, html_body, text_body)


# ============================================================================
# HIGH PRIORITY EMAILS (email_high queue)
# ============================================================================

#: Every code mail's wording, in one place, per purpose (§203).
#:
#: The bug this exists to prevent: the `two_factor` branch gave itself its own
#: plain-text body but rendered `magic_code.html`, the LOGIN template. So the
#: HTML said "use this code to sign in to FreeFrame" while the text part of the
#: same message said "two-factor verification code … if you did not try to sign
#: in, someone has your password". Which one the reader saw depended on their
#: mail client. Worse, both were wrong for the case Mathias actually hit —
#: switching two-factor ON from Settings, already signed in, told to sign in.
#:
#: So heading, lead and warning are defined ONCE per purpose and used to build
#: both parts. Modelled on SECURITY_NOTICE_BODIES below, including its rule
#: about unknown keys: an unrecognised purpose falls back to neutral wording
#: and still sends. A code the user is waiting for must never be lost to a
#: KeyError over its label.
#:
#: `subject_includes_code` is per purpose on purpose. A code in the subject is
#: convenient on a phone and is also readable on a lock screen and indexed by
#: every mail server that logs subjects. Enrolment does not need it — the user
#: is sitting in front of Settings with the app open — so that one omits it.
#: The two sign-in subjects are left as they were; changing those is a
#: separate decision.
MAIL_CODE_COPY = {
    "login": {
        "subject": "Your FreeFrame login code",
        "subject_includes_code": True,
        "heading": "Your login code",
        # No terminal punctuation: `magic_code.html` renders this followed by a
        # colon and the text body follows it with a full stop. The sentence
        # itself is the shared part, which is what the tests compare.
        "lead": "Use this code to sign in to FreeFrame",
        "warning": "If you didn't request this code, you can safely ignore this email.",
    },
    "two_factor_challenge": {
        "subject": "Your FreeFrame verification code",
        "subject_includes_code": True,
        "heading": "Your verification code",
        "lead": "Enter this code to finish signing in to FreeFrame",
        "warning": (
            "If you did not try to sign in, someone has your password — "
            "change it and tell your admin."
        ),
    },
    #: §191 called this purpose "two_factor". Kept as an alias rather than
    #: dropped, because a Celery message queued moments before this deploy
    #: still carries the old string, and an unrecognised purpose would give
    #: that reader the neutral wording instead of the challenge warning.
    "two_factor": {
        "subject": "Your FreeFrame verification code",
        "subject_includes_code": True,
        "heading": "Your verification code",
        "lead": "Enter this code to finish signing in to FreeFrame",
        "warning": (
            "If you did not try to sign in, someone has your password — "
            "change it and tell your admin."
        ),
    },
    #: §205 — confirming a CHANGE to two-factor settings: turning it off,
    #: regenerating backup codes, or replacing the method. Its own purpose for
    #: the same reason enrolment needed one — nobody is signing in, so the
    #: challenge copy's "Enter this code to finish signing in" is wrong, and
    #: its warning names the wrong danger.
    "two_factor_reauth": {
        "subject": "Confirm a change to your FreeFrame security settings",
        #: No code in the subject, matching two_factor_setup: this user is
        #: sitting in Settings with the app open, so the convenience buys
        #: nothing and the code would be readable on a lock screen.
        "subject_includes_code": False,
        "heading": "Confirm a change to your security settings",
        "lead": (
            "Enter this code in FreeFrame to confirm a change to your "
            "two-factor settings"
        ),
        #: The enrolment warning's sibling, and true for the same reason:
        #: reaching this point requires an active session, so an unexpected
        #: copy means somebody is already signed in as this person.
        "warning": (
            "If you did not just ask to change your two-factor settings, "
            "someone is signed in as you — change your password and tell "
            "your admin."
        ),
    },
    "two_factor_setup": {
        "subject": "Confirm two-factor authentication on FreeFrame",
        "subject_includes_code": False,
        "heading": "Confirm two-factor by email",
        #: "This code cannot be used to sign in" is the load-bearing sentence.
        #: Somebody who receives this unexpectedly needs to know immediately
        #: that reading it grants nothing — the opposite of what the login
        #: template told them.
        "lead": (
            "Enter this code in Settings → Profile to turn on two-factor "
            "authentication. This code cannot be used to sign in"
        ),
        #: The inverse of the challenge warning, and the reason the two cannot
        #: share copy: for enrolment nobody tried to sign in, so "someone has
        #: your password" is simply false. The real danger is that someone is
        #: ALREADY signed in.
        "warning": (
            "If you did not just turn on two-factor, someone is signed in as "
            "you — change your password and tell your admin."
        ),
    },
}

#: What an unrecognised purpose gets. Deliberately says nothing about signing
#: in either way: if the caller could not name the situation, this mail should
#: not guess at one.
NEUTRAL_CODE_COPY = {
    "subject": "Your FreeFrame verification code",
    "subject_includes_code": False,
    "heading": "Your verification code",
    "lead": "Enter this code in FreeFrame to continue",
    "warning": "If you did not request this code, you can ignore this email.",
}


def code_mail_copy(purpose: str) -> dict:
    """The wording for one code mail. Never raises; see MAIL_CODE_COPY."""
    return MAIL_CODE_COPY.get(purpose, NEUTRAL_CODE_COPY)


def _code_text_body(copy: dict, code: str, expiry_minutes: int) -> str:
    """The plain-text alternative, built from the SAME strings as the HTML.

    This function is the fix. Both parts of a multipart message now derive
    from one `copy` dict, so a change to the wording changes both or neither —
    there is no longer a way to edit one and leave the other saying the
    opposite.
    """
    # "Code: 525169" on its own rather than appended to the lead with a colon.
    # Two of the three leads end in a full sentence of their own ("This code
    # cannot be used to sign in"), and gluing the digits onto that with a colon
    # read as nonsense.
    return (
        f"{copy['heading']}. {copy['lead']}. Code: {code}. "
        f"This code expires in {expiry_minutes} minutes. "
        f"{copy['warning']}"
    )


@shared_task(bind=True, queue="email_high", max_retries=3, default_retry_delay=30)
def send_magic_code_email(self, to_email: str, code: str, expiry_minutes: int = 10, purpose: str = "login", contact_url: Optional[str] = None):
    """Send magic code email - high priority, immediate delivery."""
    try:
        if purpose == "password_reset":
            subject = f"Password reset code: {code}"
            html_body = render_template(
                "email/password_reset_code.html",
                subject=subject,
                code=code,
                expiry_minutes=expiry_minutes,
                contact_url=contact_url or "",
            )
            text_body = f"Someone requested a password reset on your FreeFrame account. Your code is: {code}. If this was not you, contact your admin. This code expires in {expiry_minutes} minutes."
        else:
            copy = code_mail_copy(purpose)
            subject = (
                f"{copy['subject']}: {code}"
                if copy["subject_includes_code"]
                else copy["subject"]
            )
            # `login` keeps rendering magic_code.html, unchanged, because it is
            # the highest-volume mail this app sends and §203 is not the place
            # to restyle it. Its wording lives in MAIL_CODE_COPY all the same,
            # so the text body below is built from the same strings the
            # template shows — and a test compares the two, which is what
            # stops the template and the dict drifting apart the way the HTML
            # and text used to.
            template = (
                "email/magic_code.html"
                if purpose == "login"
                else "email/verification_code.html"
            )
            html_body = render_template(
                template,
                subject=subject,
                code=code,
                expiry_minutes=expiry_minutes,
                heading=copy["heading"],
                lead=copy["lead"],
                warning=copy["warning"],
            )
            text_body = _code_text_body(copy, code, expiry_minutes)
        success = _send_email(to_email, subject, html_body, text_body)
        if not success:
            raise Exception("Email sending failed")
        return {"status": "sent", "to": to_email}
    except Exception as exc:
        self.retry(exc=exc)


#: §200 — what each security notice actually says, keyed by the action.
#:
#: A dict here rather than the sentence being passed in by the caller: these
#: are user-facing copy, and copy that travels through a Celery argument ends
#: up written slightly differently at each of the four call sites. The caller
#: names the ACTION; this file owns the wording.
#:
#: An unknown key falls back to a deliberately vague sentence rather than
#: raising — a notice that arrives saying less is far better than a security
#: notice that does not arrive because someone added a fifth action and
#: forgot this dict.
SECURITY_NOTICE_BODIES = {
    "password_changed": (
        "The password on this account was changed. Every other signed-in "
        "device was signed out."
    ),
    "backup_email_verified": (
        "A password-reset address was confirmed for this account. Password "
        "reset codes will be sent there from now on, and nowhere else."
    ),
    "two_factor_disabled": (
        "Two-factor authentication was turned off on this account. Signing in "
        "now needs only the password."
    ),
    "backup_codes_regenerated": (
        "A new set of two-factor backup codes was generated for this account. "
        "The previous set stopped working."
    ),
}


@shared_task(bind=True, queue="email_high", max_retries=3, default_retry_delay=30)
def send_backup_email_code_email(
    self,
    to_email: str,
    code: str,
    expiry_minutes: int,
    account_email: str,
    org_name: str = "FreeFrame",
):
    """Confirm a candidate password-reset address (§200).

    Its own task and its own template rather than a fifth `purpose` on
    send_magic_code_email, because it is the one code in this system that is
    not a credential: it grants no session, satisfies no second factor, and
    proves only that somebody can read this mailbox. The email says so —
    "nothing has changed yet" — which is the honest thing to tell someone
    who may be receiving it unexpectedly, and is the opposite of what the
    reset and login templates say.

    `account_email` is named in the body on purpose: this is sent to an
    address that may have no other relationship to FreeFrame, and a bare
    "here is your code" would be indistinguishable from phishing.
    """
    try:
        subject = f"Confirm this address for {org_name} password resets: {code}"
        html_body = render_template(
            "email/backup_email_code.html",
            subject=subject,
            code=code,
            expiry_minutes=expiry_minutes,
            account_email=account_email,
            org_name=org_name,
        )
        text_body = (
            f"Someone added this address as the password-reset address for the "
            f"{org_name} account {account_email}. Your confirmation code is: {code}. "
            f"It expires in {expiry_minutes} minutes. Nothing has changed yet — "
            f"if you were not expecting this, ignore this email."
        )
        success = _send_email(to_email, subject, html_body, text_body)
        if not success:
            raise Exception("Email sending failed")
        return {"status": "sent", "to": to_email}
    except Exception as exc:
        self.retry(exc=exc)


@shared_task(bind=True, queue="email_high", max_retries=3, default_retry_delay=30)
def send_security_notice_email(
    self,
    to_email: str,
    action: str,
    subject: str,
    account_email: str,
    contact_url: Optional[str] = None,
    org_name: str = "FreeFrame",
):
    """Tell one address that something security-relevant changed (§200).

    Called once per recipient rather than taking a list, so one undeliverable
    address cannot suppress the notice to the other — which is the entire
    reason both are written to. Celery retries per task, and a retry storm
    against a dead backup address must not also re-send to the good one.
    """
    try:
        html_body = render_template(
            "email/security_notice.html",
            subject=subject,
            body_text=SECURITY_NOTICE_BODIES.get(
                action, "A security setting on this account was changed."
            ),
            account_email=account_email,
            contact_url=contact_url or "",
            org_name=org_name,
        )
        text_body = (
            f"{subject}. This is a security notice for the {org_name} account "
            f"{account_email}. "
            + SECURITY_NOTICE_BODIES.get(
                action, "A security setting on this account was changed."
            )
            + " If this was not you, contact your administrator right away."
        )
        success = _send_email(to_email, subject, html_body, text_body)
        if not success:
            raise Exception("Email sending failed")
        return {"status": "sent", "to": to_email, "action": action}
    except Exception as exc:
        self.retry(exc=exc)


@shared_task(bind=True, queue="email_high", max_retries=3, default_retry_delay=60)
def send_invite_email(
    self,
    to_email: str,
    inviter_name: str,
    org_name: str,
    invite_link: str,
    team_name: Optional[str] = None,
    expiry_days: int = 7,
):
    """Send organization/team invite email - high priority."""
    try:
        subject = f"You've been invited to join {org_name} on FreeFrame"
        html_body = render_template(
            "email/invite.html",
            subject=subject,
            inviter_name=inviter_name,
            org_name=org_name,
            team_name=team_name,
            invite_link=invite_link,
            expiry_days=expiry_days,
        )
        text_body = f"{inviter_name} has invited you to join {org_name} on FreeFrame. Accept here: {invite_link}"
        
        success = _send_email(to_email, subject, html_body, text_body)
        if not success:
            raise Exception("Email sending failed")
        return {"status": "sent", "to": to_email}
    except Exception as exc:
        self.retry(exc=exc)


# ============================================================================
# MEDIUM PRIORITY EMAILS (email_low queue)
# ============================================================================

@shared_task(bind=True, queue="email_low", max_retries=3, default_retry_delay=120)
def send_mention_email(
    self,
    to_email: str,
    mentioner_name: str,
    asset_name: str,
    comment_preview: str,
    asset_link: str,
):
    """Send mention notification email."""
    try:
        subject = f"{mentioner_name} mentioned you on {asset_name}"
        html_body = render_template(
            "email/mention.html",
            subject=subject,
            mentioner_name=mentioner_name,
            asset_name=asset_name,
            comment_preview=comment_preview,
            asset_link=asset_link,
        )
        text_body = f"{mentioner_name} mentioned you on {asset_name}: {comment_preview}\n\nView: {asset_link}"
        
        success = _send_email(to_email, subject, html_body, text_body)
        if not success:
            raise Exception("Email sending failed")
        return {"status": "sent", "to": to_email}
    except Exception as exc:
        self.retry(exc=exc)


@shared_task(bind=True, queue="email_low", max_retries=3, default_retry_delay=120)
def send_comment_email(
    self,
    to_email: str,
    commenter_name: str,
    asset_name: str,
    comment_preview: str,
    asset_link: str,
):
    """Send new comment notification email."""
    try:
        subject = f"New comment on {asset_name}"
        html_body = render_template(
            "email/comment.html",
            subject=subject,
            commenter_name=commenter_name,
            asset_name=asset_name,
            comment_preview=comment_preview,
            asset_link=asset_link,
        )
        text_body = f"{commenter_name} commented on {asset_name}: {comment_preview}\n\nView: {asset_link}"
        
        success = _send_email(to_email, subject, html_body, text_body)
        if not success:
            raise Exception("Email sending failed")
        return {"status": "sent", "to": to_email}
    except Exception as exc:
        self.retry(exc=exc)


@shared_task(bind=True, queue="email_low", max_retries=3, default_retry_delay=120)
def send_assignment_email(
    self,
    to_email: str,
    assigner_name: str,
    asset_name: str,
    asset_link: str,
    due_date: Optional[str] = None,
    project_name: Optional[str] = None,
):
    """Send assignment notification email."""
    try:
        due_text = f" (due {due_date})" if due_date else ""
        subject = f"You've been assigned to review {asset_name}{due_text}"
        html_body = render_template(
            "email/assignment.html",
            subject=subject,
            assigner_name=assigner_name,
            asset_name=asset_name,
            asset_link=asset_link,
            due_date=due_date,
            project_name=project_name,
        )
        text_body = f"{assigner_name} assigned you to review {asset_name}.{' Due: ' + due_date if due_date else ''}\n\nView: {asset_link}"
        
        success = _send_email(to_email, subject, html_body, text_body)
        if not success:
            raise Exception("Email sending failed")
        return {"status": "sent", "to": to_email}
    except Exception as exc:
        self.retry(exc=exc)


@shared_task(bind=True, queue="email_low", max_retries=3, default_retry_delay=120)
def send_new_version_email(
    self,
    to_email: str,
    uploader_name: str,
    asset_name: str,
    version_number: int,
    asset_link: str,
    project_name: Optional[str] = None,
):
    """Send a new-version-uploaded notification email (§108)."""
    try:
        subject = f"New version of {asset_name} (v{version_number})"
        html_body = render_template(
            "email/new_version.html",
            subject=subject,
            uploader_name=uploader_name,
            asset_name=asset_name,
            version_number=version_number,
            asset_link=asset_link,
            project_name=project_name,
        )
        text_body = (
            f"{uploader_name} uploaded v{version_number} of {asset_name}.\n\nReview: {asset_link}"
        )
        success = _send_email(to_email, subject, html_body, text_body)
        if not success:
            raise Exception("Email sending failed")
        return {"status": "sent", "to": to_email}
    except Exception as exc:
        self.retry(exc=exc)


@shared_task(bind=True, queue="email_low", max_retries=3, default_retry_delay=120)
def send_share_email(
    self,
    to_email: str,
    sharer_name: str,
    asset_name: str,
    asset_link: str,
    permission: Optional[str] = None,
    message: Optional[str] = None,
):
    """Send asset shared notification email."""
    try:
        subject = f"{sharer_name} shared {asset_name} with you"
        html_body = render_template(
            "email/share.html",
            subject=subject,
            sharer_name=sharer_name,
            asset_name=asset_name,
            asset_link=asset_link,
            permission=permission,
            message=message,
        )
        text_body = f"{sharer_name} shared {asset_name} with you.\n\nView: {asset_link}"
        
        success = _send_email(to_email, subject, html_body, text_body)
        if not success:
            raise Exception("Email sending failed")
        return {"status": "sent", "to": to_email}
    except Exception as exc:
        self.retry(exc=exc)


@shared_task(bind=True, queue="email_low", max_retries=3, default_retry_delay=120)
def send_approval_email(
    self,
    to_email: str,
    reviewer_name: str,
    asset_name: str,
    status: str,  # "approved" or "rejected"
    asset_link: str,
    note: Optional[str] = None,
):
    """Send approval/rejection notification email."""
    try:
        status_emoji = "✅" if status == "approved" else "❌"
        subject = f"{status_emoji} {asset_name} has been {status}"
        html_body = render_template(
            "email/approval.html",
            subject=subject,
            reviewer_name=reviewer_name,
            asset_name=asset_name,
            status=status,
            asset_link=asset_link,
            note=note,
        )
        text_body = f"{reviewer_name} {status} {asset_name}.{' Note: ' + note if note else ''}\n\nView: {asset_link}"
        
        success = _send_email(to_email, subject, html_body, text_body)
        if not success:
            raise Exception("Email sending failed")
        return {"status": "sent", "to": to_email}
    except Exception as exc:
        self.retry(exc=exc)


@shared_task(bind=True, queue="email_low", max_retries=3, default_retry_delay=120)
def send_project_added_email(
    self,
    to_email: str,
    adder_name: str,
    project_name: str,
    project_link: str,
    org_name: Optional[str] = None,
    role: Optional[str] = None,
):
    """Send project added notification email."""
    try:
        subject = f"You've been added to {project_name}"
        html_body = render_template(
            "email/project_added.html",
            subject=subject,
            adder_name=adder_name,
            project_name=project_name,
            project_link=project_link,
            org_name=org_name,
            role=role,
        )
        text_body = f"{adder_name} added you to {project_name}.\n\nView: {project_link}"
        
        success = _send_email(to_email, subject, html_body, text_body)
        if not success:
            raise Exception("Email sending failed")
        return {"status": "sent", "to": to_email}
    except Exception as exc:
        self.retry(exc=exc)
