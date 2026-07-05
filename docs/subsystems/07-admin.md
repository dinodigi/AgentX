# 07 · Admin ✅ DONE 2026-07-05 (visual pass by a human still recommended)

Purpose: the handoff artifact — the thing the client actually receives.
All built + typechecked + route-compile-checked; admin sits behind Clerk so
the smoke suite can't exercise the UI — eyeball it before the next handoff.

## Sub-features

- [x] **Richtext editor** (M) — TipTap StarterKit (bold/italic/H2/H3/lists/
      quote), HTML via hidden input so form coercion is untouched.
- [x] **Inbox affordances** (S/M) — new/handled toggle chip per submission
      (entries.handled_at, workflow metadata — never in entry data), unhandled
      row tint, per-inbox count badges in the sidebar.
- [x] **Asset manager** (M) — Media page: preview grid, upload, two-click
      delete; a referenced-file delete surfaces the data layer's hint inline.
      ("what uses each file" = the hint names the count; per-file usage list
      deferred.) "assets" is now a reserved slug.
- [x] **Searchable relation picker** (M) — typeahead combobox over the
      preloaded choices; the 500 cap is surfaced in the dropdown.
- [x] **Audit log UI** (S) — History panel on the entry page: action, actor
      (agent / admin / site user), changed fields, timestamps.
- [x] **Mobile pass** (M) — ink rail becomes a slide-in drawer with hamburger
      + scrim under md:, responsive paddings; tables already scrolled.
- [x] **Onboarding polish** (S) — empty states teach the agent workflow
      (Settings → token/endpoint, API reference) and the seeding/form paths.

Done when: you'd hand it to a paying client without a walkthrough call.
