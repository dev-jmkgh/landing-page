# Image assets

No JMK-owned photography was supplied with the content document, so **every image slot on
the site currently renders a branded geometric placeholder**. Nothing on the site pretends
to be a photo of a JMK office, team, project or client.

## Folder map

```
public/images/
  hero/           Home hero imagery (optional — the hero currently uses a structural diagram)
  about/          About page — office, leadership, workplace
  business/       Our Business overview page
  academy/        JMK Academy — classrooms, training sessions, workshops
  design-studio/  JMK Design Studio — CAD work, drawings, renders
  software/       JMK Software Solutions — product screens, team
  gallery/        Gallery grid images
  careers/        Careers page imagery
  og/             Custom social share images (the default card is generated at build time)
```

## Replacing a placeholder

1. **Add the file.** Drop an optimised image into the matching folder. Recommended:
   - Format: `.webp` (preferred) or `.jpg`
   - Gallery / card images: 1600 × 1200 px, under 300 KB
   - Wide hero images: 2000 × 1125 px, under 500 KB
2. **Point a slot at it.**
   - *Gallery:* edit `frontend/src/lib/content/gallery.ts` and set `src` and a truthful
     `alt` on the matching slot, e.g.
     ```ts
     { id: 'academy-01', category: 'academy', src: '/images/gallery/academy-01.webp',
       alt: 'Students at a CAD training session in the Coimbatore centre' }
     ```
   - *Any other page:* pass `src` and `alt` to the `<MediaFigure />` component in that page.
3. **Write real alt text.** Describe what the photograph actually shows. `MediaFigure`
   only renders an `<img>` when both `src` and `alt` are provided — a missing `alt` falls
   back to the placeholder rather than shipping an inaccessible image.

## Rules

- Do not add stock photography that implies it shows JMK facilities, staff or projects.
- Do not add client logos without written permission from that client.
- Keep file names lowercase and hyphenated: `cad-training-session-01.webp`.
