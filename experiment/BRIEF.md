# Build Brief — Tidewater Expeditions

You are building the complete web presence for **Tidewater Expeditions**, a
small-batch sea-kayaking tour company. The owner, Mara, is not technical. The
deliverable is two things: a public website her customers use, and an admin
dashboard she uses to run the business without ever calling a developer.

Brand: name "Tidewater Expeditions", deep teal `#0e7490` as the primary color,
any simple logo mark you generate or a styled wordmark.

## The data

The business runs on this information. Model it however you think is right.

**Guides** — people who lead trips.
- Public: name, short bio (formatted text), portrait photo.
- Private (owner-only): personal email, day rate.

**Trips** — the tour products (e.g. "Bioluminescence Night Paddle").
- Public: title, url slug, description (formatted text), difficulty (one of:
  easy, moderate, challenging), price per person (number), duration in hours,
  hero image, the guide who leads it, whether it's featured on the homepage.
- Private: internal margin notes.

**Departures** — scheduled dates a trip actually runs.
- Public: which trip, date, availability status (one of: open, limited, sold_out).
- Private: internal capacity notes.

**Booking inquiries** — submitted by visitors from the website.
- Fields: name, email, which departure they're interested in, party size
  (number), message.
- NOTHING about an inquiry is ever publicly readable. Submissions must also
  fire a webhook notification (URL provided at build time) so Mara gets pinged.
- Mara needs to see inquiries in her admin and mark them handled.

**Testimonials** — customer quotes.
- Fields: quote, customer name, which trip, approved (yes/no).
- Only approved testimonials appear on the website.

## The public website (Next.js + TypeScript)

1. **Home** — hero, the featured trips, approved testimonials.
2. **/trips** — all trips; filterable by difficulty; sortable by price
   (both must actually refetch/requery, not just hide DOM nodes).
3. **/trips/[slug]** — full trip detail: description, price, duration, guide
   card (portrait + bio), and its upcoming departures with availability badges.
   Sold-out departures are visibly not bookable.
4. **Booking inquiry form** — on the trip page, pre-scoped to a departure.
   Client + server validation, clear success state, graceful error state.

## The admin (Mara's side)

- Sign-in required. Mara's account only — no public registration.
- Branded: Tidewater name, color, logo. It should feel like HER tool.
- She can: create/edit/delete trips, guides, departures, and testimonials;
  upload images; approve testimonials; see booking inquiries newest-first and
  mark them handled.
- She must never be able to break the site with bad input (validation
  everywhere: difficulty must be one of the three values, dates must be dates,
  a departure must point at a real trip, etc.).

## Hard privacy requirements (will be audited)

Anyone inspecting network traffic, the public API, or page source must NOT be
able to obtain: guide emails, guide day rates, margin notes, capacity notes, or
any booking-inquiry data. Availability status is public; who inquired is not.

## Seed content (part of the job)

Realistic, coherent content — not lorem ipsum: 3 guides (with portraits — any
royalty-free or generated images are fine), 6 trips (all fields, varied
difficulties/prices, distinct hero images), at least 12 future departures
spread across the trips with a mix of statuses, 6 testimonials (4 approved,
2 pending).

## Definition of done

Every item in this brief works end-to-end on localhost: the site renders from
real stored data, the form writes real records and fires the webhook, the
admin manages everything listed, the privacy audit passes, and the seed
content is in place. State clearly when you believe you are done.
