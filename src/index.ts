import 'dotenv/config';
import { getActiveBrand } from './brands.js';

const brand = getActiveBrand();

console.log('NEXUS CONTENT STUDIO');
console.log('--------------------');
console.log(`Active brand: ${brand.name}`);
console.log(`Tagline: ${brand.tagline}`);
console.log(`Mode: ${process.env.NEXUS_MODE ?? 'approval'}`);
console.log('Status: software scaffold ready; provider credentials/integrations not connected yet.');
