/**
 * Shared storefront catalog.
 * Product IDs are stable order/cart keys; use these names when adding products.
 * This file is imported by both the browser storefront and the Node server.
 */
export const PRODUCT_SIZES = ['S', 'M', 'L', 'XL', 'XXL'];

export const TEE_SIZE_CHART = [
  { size: 'S', chest: 104, length: 69, shoulder: 49, sleeve: 22 },
  { size: 'M', chest: 110, length: 71, shoulder: 51, sleeve: 23 },
  { size: 'L', chest: 116, length: 73, shoulder: 53, sleeve: 24 },
  { size: 'XL', chest: 122, length: 75, shoulder: 55, sleeve: 25 },
  { size: 'XXL', chest: 128, length: 77, shoulder: 57, sleeve: 26 },
];

export const PRODUCTS = [
  {
    id: 'del-stop',
    sku: 'ML-TEE-001',
    name: 'Del Stop Crew',
    price: 799,
    stock: 5,
    color: 'white',
    images: ['del-stop-front.png', 'del-stop-back.jpg', 'campaign-del-stop.png'],
    description: 'For every corner that made us. A heavyweight, oversized tee with Delhi mapped across the back.',
    fit: 'Oversized fit · 240 GSM cotton',
  },
  {
    id: 'red-flag',
    sku: 'ML-TEE-002',
    name: 'The Red Flag',
    price: 799,
    stock: 5,
    color: 'white',
    images: ['malang-front.jpg', 'red-flag-back.jpg'],
    description: 'Some warnings are better worn. Soft cotton, easy drape, and a message that says enough.',
    fit: 'Oversized fit · 240 GSM cotton',
  },
  {
    id: 'love-overflow',
    sku: 'ML-TEE-003',
    name: 'The Hand Tee',
    price: 699,
    stock: 5,
    color: 'white',
    images: ['malang-front.jpg', 'love-overflow-back.png'],
    description: 'A little too much feeling, in the best way. An everyday tee with a hand-drawn reminder on the back.',
    fit: 'Relaxed fit · 220 GSM cotton',
  },
  {
    id: 'forever-baddie',
    sku: 'ML-TEE-004',
    name: 'Forever Baddie',
    price: 949,
    stock: 5,
    color: 'black',
    images: ['malang-black-front.png', 'forever-baddie-back.png'],
    description: 'A portrait of the ones who taught us how to be. Printed on our soft, heavyweight black cotton tee.',
    fit: 'Oversized fit · 240 GSM cotton',
  },
  {
    id: 'malang-basics',
    sku: 'ML-TEE-005',
    name: 'Malang Basics',
    price: 549,
    stock: 5,
    color: 'black',
    images: ['malang-black-front.png', 'black-tee-front.jpg', 'black-tee-back.jpg'],
    description: 'The everyday uniform. Clean on the front, made to move through the city.',
    fit: 'Relaxed fit · 220 GSM cotton',
  },
];

export const PRODUCTS_BY_ID = Object.fromEntries(PRODUCTS.map((product) => [product.id, product]));
