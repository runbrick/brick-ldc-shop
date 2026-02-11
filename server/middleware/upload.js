import multer from 'multer';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const uploadDir = path.join(__dirname, '..', '..', 'public', 'uploads');

if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, uploadDir),
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname) || '.jpg';
    const name = Date.now() + '-' + Math.random().toString(36).slice(2, 8) + ext;
    cb(null, name);
  },
});

export const uploadSingle = multer({ storage }).single('file');
export const uploadCover = multer({ storage }).single('cover_image');
export const uploadBackground = multer({ storage }).single('site_background_image');
export const uploadPaymentQR = multer({ storage }).single('payment_qr_image');
export const uploadSettings = multer({ storage }).fields([
  { name: 'site_background_image', maxCount: 1 },
  { name: 'payment_qr_image', maxCount: 1 }
]);

export function getUploadUrl(filename) {
  return '/uploads/' + filename;
}
