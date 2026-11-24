/**
 * Whether this browser shows JPEG XL, told to the hub as a cookie (hub jxl.ts, docs/files.md "JPEG XL"). With it the
 * hub sends kept pictures as JPEG XL, a third smaller, and a JPEG XL someone sent as it is; without it every picture
 * comes as a JPEG or PNG. Looked at on each start, so a browser that learns JPEG XL gets it from then on.
 */

/** A 1×1 lossless JPEG XL. */
const PIXEL = 'data:image/jxl;base64,/woAEBAJCAABACgASxiLFcJJQU5/AA==';
const COOKIE = 'dither_jxl';

export async function noteJxl(): Promise<boolean> {
  let ok = false;
  try {
    const img = new Image();
    img.src = PIXEL;
    await img.decode();
    ok = img.naturalWidth === 1;
  } catch {}
  const secure = location.protocol === 'https:' ? '; secure' : '';
  document.cookie = ok ? `${COOKIE}=1; path=/; max-age=31536000; samesite=strict${secure}` : `${COOKIE}=; path=/; max-age=0; samesite=strict${secure}`;
  return ok;
}
