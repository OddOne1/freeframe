import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'

const PUBLIC_ROUTES = ['/login', '/setup']
const PUBLIC_PREFIXES = ['/invite/', '/share/']

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8000'

function isPublicRoute(pathname: string): boolean {
  if (PUBLIC_ROUTES.includes(pathname)) return true
  if (PUBLIC_PREFIXES.some((prefix) => pathname.startsWith(prefix))) return true
  return false
}

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl

  // Always allow public routes
  if (isPublicRoute(pathname)) {
    return NextResponse.next()
  }

  // Is this instance set up at all? Redirect to /setup if no superadmin
  // exists. Cached in a cookie so the API is not asked on every request.
  //
  // §199 — a flag, not an early `return NextResponse.next()`. That early
  // return was an AUTH BYPASS: on any request WITHOUT the cookie — every
  // first request from a new browser, after a cookie clear, or after its
  // 24h expiry — this branch answered `next()` and the token check below
  // never ran at all. The API still refused the data, so nothing leaked,
  // but a gate that lets people through on their first knock is not a gate.
  // The cookie is now set on the response the auth check produces, so
  // "remember that setup is done" and "is this request allowed" stay two
  // separate decisions.
  let markSetupDone = false
  const setupDone = request.cookies.get('ff_setup_done')?.value
  if (!setupDone) {
    try {
      const res = await fetch(`${API_URL}/setup/status`, {
        next: { revalidate: 60 }, // Cache for 60 seconds
      })
      if (res.ok) {
        const data = await res.json()
        if (data.needs_setup) {
          return NextResponse.redirect(new URL('/setup', request.url))
        }
        markSetupDone = true
      }
    } catch {
      // API unreachable — fall through. The auth check below still applies,
      // and the page surfaces the error rather than this pretending to know.
    }
  }

  // Check for auth tokens
  const accessToken = request.cookies.get('ff_access_token')?.value
  const refreshToken = request.cookies.get('ff_refresh_token')?.value

  if (!accessToken && !refreshToken) {
    const loginUrl = new URL('/login', request.url)
    loginUrl.searchParams.set('from', pathname)
    return NextResponse.redirect(loginUrl)
  }

  const response = NextResponse.next()
  if (markSetupDone) {
    // Setup is done — remember it so the API is not asked again
    response.cookies.set('ff_setup_done', '1', { path: '/', maxAge: 60 * 60 * 24 }) // 24 hours
  }
  return response
}

export const config = {
  matcher: [
    /*
     * Match all paths except:
     * - _next/static (static files)
     * - _next/image (image optimization)
     * - favicon.ico
     * - api routes
     * - public assets (images, fonts, etc.)
     */
    '/((?!_next/static|_next/image|favicon\\.ico|api/|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico|woff|woff2|ttf|otf)).*)',
  ],
}
