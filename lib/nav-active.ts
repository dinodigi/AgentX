/**
 * Which nav item is "current" for a given path — LONGEST match wins.
 *
 * WHY THIS IS NOT `pathname.startsWith(href)`. That was the rule, and it meant an
 * index route matched every one of its children: on `/admin/<id>/connectors` the
 * Overview item (href `/admin/<id>`) tested true, so Overview stayed highlighted
 * no matter where you navigated, and two items lit at once. The same bug hit the
 * platform group, where `/admin/console/feedback` highlighted both Console and
 * Feedback.
 *
 * Longest-prefix wins fixes the whole class rather than special-casing the two
 * index routes we happen to have today, so a future nested route cannot
 * reintroduce it.
 *
 * Pure and dependency-free so it can be asserted directly — the sidebar is a
 * client component and this is the only part of it worth testing.
 */
export function activeHref(pathname: string, hrefs: string[], exactOnly: string[] = []): string | null {
  let best: string | null = null;
  for (const href of hrefs) {
    // An INDEX route matches only itself. Overview is the case that matters: a
    // project's children include every collection, and highlighting Overview
    // while the reader is inside `posts` is the same lie in a smaller form —
    // content is tracked by the other sidebar, so the rail should show nothing.
    if (exactOnly.includes(href)) {
      if (pathname === href) best = best === null || href.length > best.length ? href : best;
      continue;
    }
    // A prefix only counts at a SEGMENT boundary: `/admin/new` must not be
    // considered a child of `/admin/newsletter`.
    const isMatch = pathname === href || pathname.startsWith(href.endsWith("/") ? href : href + "/");
    if (!isMatch) continue;
    if (best === null || href.length > best.length) best = href;
  }
  return best;
}
