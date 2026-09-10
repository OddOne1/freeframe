import { resolveApiMediaUrl } from '@/lib/utils'

/**
 * Start a browser download for a URL the API handed back (§141).
 *
 * One definition, because six hand-rolled copies of "make a hidden iframe
 * and set .src" is what allowed three of them to forget
 * `resolveApiMediaUrl()` and 404. `proxy_url_for()` returns a RELATIVE path
 * ("/stream/hls/...?token=..."), so an unresolved value resolves against
 * the page origin instead of the API.
 *
 * Resolution happens HERE and nowhere else on the path. It is not
 * idempotent: in production `NEXT_PUBLIC_API_URL` is itself '/api', so a
 * resolved string still starts with '/' and a second pass produces
 * '/api/api/...' — the exact bug §32 and §139 were filed for. Callers pass
 * the raw `data.url` straight from the response.
 *
 * An iframe rather than an anchor: the server sends Content-Disposition, and
 * an iframe lets the browser act on it without a navigation, without
 * needing `a.download` (which would override the filename the backend
 * chose, stripping the extension it just appended).
 */
export function triggerBrowserDownload(url: string | null | undefined): boolean {
  const resolved = resolveApiMediaUrl(url)
  if (!resolved) return false
  const iframe = document.createElement('iframe')
  iframe.style.display = 'none'
  iframe.src = resolved
  document.body.appendChild(iframe)
  setTimeout(() => iframe.remove(), 30000)
  return true
}
