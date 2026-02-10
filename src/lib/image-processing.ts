/**
 * Client-side image processing pipeline for home profile photos.
 *
 * For every uploaded image:
 * 1. Decode (including HEIC/HEIF via heic2any)
 * 2. Resize so longest side ≤ 2400 px (high-quality bicubic via canvas)
 * 3. Encode as WebP at quality 84, stripping EXIF
 * 4. Return the WebP blob + dimensions
 */

const MAX_LONG_SIDE = 2400;
const WEBP_QUALITY = 0.84;

interface ProcessedImage {
  blob: Blob;
  width: number;
  height: number;
  originalFilename: string;
}

/**
 * Checks if a file is HEIC/HEIF by extension or MIME type.
 */
function isHeic(file: File): boolean {
  const name = file.name.toLowerCase();
  return (
    name.endsWith('.heic') ||
    name.endsWith('.heif') ||
    file.type === 'image/heic' ||
    file.type === 'image/heif'
  );
}

/**
 * Convert a HEIC/HEIF file to a PNG blob using heic2any.
 */
async function convertHeic(file: File): Promise<Blob> {
  const heic2any = (await import('heic2any')).default;
  const result = await heic2any({ blob: file, toType: 'image/png', quality: 1 });
  return Array.isArray(result) ? result[0] : result;
}

/**
 * Load a blob (JPEG/PNG/WebP) into an HTMLImageElement.
 */
function loadImage(blob: Blob): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(img.src);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(img.src);
      reject(new Error('Failed to load image'));
    };
    img.src = URL.createObjectURL(blob);
  });
}

/**
 * Resize + convert to WebP using an OffscreenCanvas (or regular canvas fallback).
 * Uses imageSmoothingQuality "high" for bicubic resampling (best available in browsers).
 */
function resizeAndEncodeWebP(
  img: HTMLImageElement,
): Promise<{ blob: Blob; width: number; height: number }> {
  let { naturalWidth: w, naturalHeight: h } = img;

  // Resize so longest side ≤ MAX_LONG_SIDE
  const longest = Math.max(w, h);
  if (longest > MAX_LONG_SIDE) {
    const scale = MAX_LONG_SIDE / longest;
    w = Math.round(w * scale);
    h = Math.round(h * scale);
  }

  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d')!;
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high'; // bicubic – best browser-available resampling
  ctx.drawImage(img, 0, 0, w, h);

  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (!blob) return reject(new Error('WebP encoding failed'));
        resolve({ blob, width: w, height: h });
      },
      'image/webp',
      WEBP_QUALITY,
    );
  });
}

/**
 * Full pipeline: file → decoded → resized → WebP blob + metadata.
 */
export async function processImage(file: File): Promise<ProcessedImage> {
  // 1. Decode HEIC if needed
  let decodable: Blob = file;
  if (isHeic(file)) {
    decodable = await convertHeic(file);
  }

  // 2. Load into image element (strips EXIF because canvas never copies it)
  const img = await loadImage(decodable);

  // 3. Resize & encode to WebP
  const { blob, width, height } = await resizeAndEncodeWebP(img);

  return {
    blob,
    width,
    height,
    originalFilename: file.name,
  };
}

export const ACCEPTED_IMAGE_TYPES = '.jpg,.jpeg,.png,.heic,.heif,.webp';
export const ACCEPTED_MIME_TYPES = [
  'image/jpeg',
  'image/png',
  'image/heic',
  'image/heif',
  'image/webp',
];
