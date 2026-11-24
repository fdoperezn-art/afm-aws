// Reducción de fotos en el teléfono antes de subirlas.
// Una foto de celular pesa 3–5 MB; reducida a 1600 px en JPEG pesa ~300 KB y se ve bien para mostrar el problema.
// Al volver a codificarla se eliminan los metadatos EXIF (incluida la ubicación GPS donde se tomó).
import { PHOTO_MAX_SIDE, PHOTO_QUALITY, UPLOAD_TYPE } from '../../../shared/rules.js';

function loadImage(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = url; // los navegadores actuales respetan la orientación EXIF al dibujar
  });
}

/** Devuelve { blob, url } con la foto reducida en JPEG. Lanza un error si no se puede leer. */
export async function reducePhoto(file) {
  const sourceUrl = URL.createObjectURL(file);
  try {
    const img = await loadImage(sourceUrl);
    const scale = Math.min(1, PHOTO_MAX_SIDE / Math.max(img.naturalWidth, img.naturalHeight));
    const width = Math.max(1, Math.round(img.naturalWidth * scale));
    const height = Math.max(1, Math.round(img.naturalHeight * scale));
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff'; // fondo blanco para PNG con transparencia
    ctx.fillRect(0, 0, width, height);
    ctx.drawImage(img, 0, 0, width, height);
    const blob = await new Promise((resolve, reject) =>
      canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('No se pudo procesar la foto'))), UPLOAD_TYPE, PHOTO_QUALITY),
    );
    return { blob, url: URL.createObjectURL(blob) };
  } finally {
    URL.revokeObjectURL(sourceUrl);
  }
}
