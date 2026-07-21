# Build Brief — Northgate Pottery Studio

You are building the complete web presence for **Northgate Pottery**, a
members' ceramics studio. The owner, Jonah, is not technical. The deliverable
is two things: a public website his customers use, and an internal dashboard
he and his instructors use to run the studio without ever calling a developer.

Brand: name "Northgate Pottery", warm clay orange `#c2410c` as the primary
color, any simple logo mark you generate or a styled wordmark.

## The business

Northgate sells memberships. Members book studio equipment by the hour, take
scheduled classes, and show off finished work. Classes fill up fast, so there
is a waiting list. Jonah wants to hear from members about what to improve.

## The data

Model this however you think is right.

**Members** — the people who use the studio.
- Profile: name, email, optional photo.
- Role: one of `member`, `instructor`, `admin`. A member must never be able to
  change their own role.
- Account state: a member can be `invited`, `active`, `suspended`, or
  `deactivated`. Suspended members cannot book anything.

**Equipment** — bookable resources: 4 pottery wheels, 2 kilns, 1 glaze station.

**Bookings** — a member reserving one piece of equipment for a date + time slot.
- Slots are hourly, 9:00 through 20:00.
- **The same piece of equipment can never be booked twice for the same date and
  slot.** This must hold even if two people submit at the same instant.
- A booking starts as `held`, becomes `confirmed`, and can be `canceled`.
- Holds that are never confirmed within 24 hours must be released automatically,
  without anyone clicking anything.

**Classes** — scheduled group sessions (e.g. "Beginner Wheel Throwing").
- Public: title, description, date, instructor, capacity, price.
- When a class is full, visitors join a **waiting list** by email. The same
  email must not be able to join the same list twice. Jonah invites people off
  the list; each invitation carries a unique code they redeem to claim a spot.

**Gallery** — photos of member work.
- Grouped into albums with a title, description, cover image and many images.
- An album is either published or not. **Unpublished albums must not be
  visible on the public site at all** — not merely unlisted.

**Enquiries** — submitted from the public site by people who are not members
yet: name, email, message. Jonah works through them and marks each handled.

**Member feedback** — submitted by signed-in members: a short summary, detail,
and a category (bug / idea / friction / praise). Jonah triages each item
through: new → reviewed → planned → done or dismissed. **The submitter must
never be able to set the triage status themselves.**

**Notifications** — members see an in-app feed with an unread count:
- "your booking is confirmed"
- "a spot opened in a class you're waiting for"
- studio-wide announcements Jonah writes, which he can draft first and publish
  when ready.
Members can mute a notification topic they don't care about. A given
notification must never be delivered to the same member twice.

## The public website

- **Home** — the studio, featured classes, a few published gallery albums.
- **Classes** — upcoming classes; full ones show a "join the waiting list" form.
- **Gallery** — published albums; opening one shows its images.
- **Contact** — the enquiry form, with client-side and server-side validation.
- Pages must be search-engine friendly: sensible titles, meta descriptions,
  clean URLs, and correct metadata when a class or album is shared as a link.

## The member area (sign-in required)

- Book equipment: pick equipment, date, slot. Double-booking is rejected with a
  clear message and the next free slot offered.
- See and cancel my bookings.
- My notification feed with unread count; mark read; mute a topic.
- Submit feedback.

## The studio dashboard (Jonah + instructors)

- Today's bookings; confirm or cancel any of them.
- Members list: invite, suspend, reinstate. Only `admin` may change roles.
- Classes: create, edit, see the waiting list, invite the next people.
- Gallery: create albums, upload images, publish and unpublish.
- Enquiries: newest first, mark handled.
- Feedback: triage through the pipeline, filter by category.
- Announcements: draft, then publish.

## Seed data

Enough to look real: 7 equipment items, 6 members across all three roles,
4 classes (one already full), 3 gallery albums (one unpublished) with at least
4 images each, 5 enquiries, 4 feedback items across categories.

Images: any royalty-free ceramics photos are fine — hotlink-free public URLs
you fetch, or generated placeholders. Don't spend real time on photography.

## Definition of done

1. Both sites run and every page above works end to end.
2. Every invariant stated in bold above actually holds when tested directly.
3. Seed data is loaded.
4. A `README.md` explains how to run it and how Jonah does the five most
   common tasks.

Work until the definition of done is met. If you must make a product decision
the brief doesn't cover, make a reasonable one and note it in the README.
