import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { PRODUCTS_BY_ID, PRODUCT_SIZES } from '../shared/catalog.js';

const PROJECT_ROOT=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const MIME={'.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'text/javascript; charset=utf-8','.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.svg':'image/svg+xml','.json':'application/json; charset=utf-8','.ico':'image/x-icon'};
const VALID_PRODUCT_SIZES=new Set(PRODUCT_SIZES);
const pendingOrders=new Map();
const authChallenges=new Map(),sessions=new Map();
const codAttempts=new Map();
const shippingQuoteAttempts=new Map();
const shipmentRetryLocks=new Set();

function loadLocalEnv(){
  const envPath=path.join(PROJECT_ROOT,'.env');if(!fs.existsSync(envPath))return;
  for(const line of fs.readFileSync(envPath,'utf8').split(/\r?\n/)){
    const match=line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);if(!match||match[1] in process.env)continue;
    process.env[match[1]]=match[2].replace(/^(['"])(.*)\1$/,'$2');
  }
}
loadLocalEnv();
const keyId=process.env.RAZORPAY_KEY_ID||'';
const keySecret=process.env.RAZORPAY_KEY_SECRET||'';
const razorpayMode=keyId.startsWith('rzp_live_')?'live':keyId.startsWith('rzp_test_')?'test':'';
const livePaymentsAllowed=razorpayMode==='live'&&process.env.NODE_ENV==='production'&&publicHttpsUrl(process.env.PUBLIC_STORE_URL||'');
const shiprocketEmail=process.env.SHIPROCKET_API_EMAIL||'';
const shiprocketPassword=process.env.SHIPROCKET_API_PASSWORD||'';
const shiprocketPickup=process.env.SHIPROCKET_PICKUP_LOCATION||'';
const packageDimensions={length:Number(process.env.SHIPROCKET_PACKAGE_LENGTH_CM),breadth:Number(process.env.SHIPROCKET_PACKAGE_BREADTH_CM),height:Number(process.env.SHIPROCKET_PACKAGE_HEIGHT_CM),weight:Number(process.env.SHIPROCKET_PACKAGE_WEIGHT_KG)};
const gstRegistered=/^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/.test((process.env.GSTIN||'').trim().toUpperCase());
const shiprocketEnabled=Boolean(shiprocketEmail.includes('@')&&shiprocketPassword.length>8&&shiprocketPickup&&!/(replace|placeholder|example\.com)/i.test(`${shiprocketEmail} ${shiprocketPassword} ${shiprocketPickup}`)&&Object.values(packageDimensions).every(value=>Number.isFinite(value)&&value>0));
const shiprocketBase='https://apiv2.shiprocket.in/v1/external';
let shiprocketAuthCache={token:'',expiresAt:0};
let shiprocketPickupPostcodeCache={value:'',expiresAt:0};
const resendApiKey=process.env.RESEND_API_KEY||'',emailFrom=process.env.EMAIL_FROM||'',publicStoreUrl=(process.env.PUBLIC_STORE_URL||(process.env.VERCEL_URL?`https://${process.env.VERCEL_URL}`:'http://127.0.0.1:4173')).replace(/\/$/,'');
const emailEnabled=resendApiKey.startsWith('re_')&&emailFrom.includes('@')&&!/(replace|placeholder|your-domain|your-verified-domain|example\.com|localhost)/i.test(`${resendApiKey} ${emailFrom}`);
const supabaseUrl=(process.env.SUPABASE_URL||'').replace(/\/$/,'');
const supabaseKey=process.env.SUPABASE_SECRET_KEY||process.env.SUPABASE_SERVICE_ROLE_KEY||'';
const databaseEnabled=/^https:\/\/[a-z0-9-]+\.supabase\.co$/i.test(supabaseUrl)&&/^(sb_secret_|eyJ)/.test(supabaseKey)&&!/(replace|placeholder|your-project)/i.test(`${supabaseUrl} ${supabaseKey}`);
const paymentsEnabled=Boolean(razorpayMode&&keySecret.length>10&&!/replace|placeholder|your_key/i.test(`${keyId} ${keySecret}`)&&((razorpayMode==='live'&&livePaymentsAllowed)||(razorpayMode==='test'&&process.env.VERCEL!=='1'))&&(process.env.VERCEL!=='1'||databaseEnabled));
const adminEmails=new Set([process.env.ADMIN_EMAIL||'',...(process.env.ADMIN_EMAILS||'').split(',')].map(normalizeEmail).filter(Boolean));
const adminPasswordHash=process.env.ADMIN_PASSWORD_HASH||'';
const adminPasswordHashes=(()=>{try{return new Map(Object.entries(JSON.parse(process.env.ADMIN_PASSWORD_HASHES||'{}')).map(([email,hash])=>[normalizeEmail(email),String(hash)]));}catch{return new Map();}})();

function publicHttpsUrl(value){try{return new URL(value).protocol==='https:';}catch{return false;}}
function allowedOrigins(){const origins=new Set(['http://127.0.0.1:4173','http://localhost:4173']);try{origins.add(new URL(publicStoreUrl).origin);}catch{}for(const domain of [process.env.VERCEL_URL,process.env.VERCEL_PROJECT_PRODUCTION_URL].filter(Boolean))origins.add(`https://${domain}`);return origins;}
function allowedHosts(){const hosts=new Set(['127.0.0.1:4173','localhost:4173']);try{hosts.add(new URL(publicStoreUrl).host);}catch{}for(const domain of [process.env.VERCEL_URL,process.env.VERCEL_PROJECT_PRODUCTION_URL].filter(Boolean))hosts.add(domain);return hosts;}

function send(res,status,data){res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(JSON.stringify(data));}
function readJson(req){return new Promise((resolve,reject)=>{let raw='';req.on('data',chunk=>{raw+=chunk;if(raw.length>32768){reject(new Error('Request too large'));req.destroy();}});req.on('end',()=>{try{resolve(JSON.parse(raw||'{}'));}catch{reject(new Error('Invalid JSON'));}});req.on('error',reject);});}
function priceCart(lines,coupon,stock=PRODUCTS_BY_ID){
  if(!Array.isArray(lines)||lines.length<1||lines.length>20)throw new Error('Your bag is empty or contains too many line items.');
  const productQuantities=new Map();
  const items=lines.map(line=>{
    const product=PRODUCTS_BY_ID[line?.id],qty=Number(line?.qty),size=String(line?.size||'');
    if(!product||!VALID_PRODUCT_SIZES.has(size)||!Number.isInteger(qty)||qty<1||qty>5)throw new Error('One of the items in your bag is invalid.');
    const productQuantity=(productQuantities.get(product.id)||0)+qty;
    const available=Number(stock[product.id]??product.stock);if(available<1||productQuantity>available)throw new Error(available<1?`${product.name} is out of stock.`:`${product.name} has only ${available} pieces available.`);
    productQuantities.set(product.id,productQuantity);
    return {id:line.id,sku:product.sku,name:product.name,size,qty,unitPrice:product.price,lineTotal:product.price*qty};
  });
  const subtotal=items.reduce((sum,item)=>sum+item.lineTotal,0);
  const discount=coupon==='WELCOME10'?Math.round(subtotal*.1):0;
  const gst=gstRegistered?Math.round((subtotal-discount)*.05):0;
  const shipping=0;
  return {items,subtotal,discount,gst,shipping,total:subtotal-discount+gst+shipping};
}
function cleanField(value,max){return String(value??'').replace(/[\u0000-\u001f\u007f]/g,' ').trim().slice(0,max);}
function validateCustomer(input){
  const customer={name:cleanField(input?.name,100),email:cleanField(input?.email,160),phone:cleanField(input?.phone,24),address:cleanField(input?.address,240),city:cleanField(input?.city,100),state:cleanField(input?.state,100),pincode:cleanField(input?.pincode,6),country:'India'};
  if(customer.name.length<2||!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(customer.email)||!/^[0-9+ ()-]{8,16}$/.test(customer.phone)||customer.address.length<5||customer.city.length<2||customer.state.length<2||!/^[0-9]{6}$/.test(customer.pincode))throw new Error('Please check your contact and delivery details.');
  return customer;
}
function razorpayRequest(method,route,payload){
  return new Promise((resolve,reject)=>{
    const body=payload?JSON.stringify(payload):'';
    const request=https.request({hostname:'api.razorpay.com',path:`/v1${route}`,method,headers:{Authorization:`Basic ${Buffer.from(`${keyId}:${keySecret}`).toString('base64')}`,'Content-Type':'application/json',...(body?{'Content-Length':Buffer.byteLength(body)}:{})}},response=>{
      let raw='';response.setEncoding('utf8');response.on('data',chunk=>raw+=chunk);response.on('end',()=>{let data={};try{data=JSON.parse(raw);}catch{}if(response.statusCode<200||response.statusCode>=300){reject(new Error(data?.error?.description||'Razorpay could not complete the request.'));return;}resolve(data);});
    });
    request.setTimeout(12000,()=>request.destroy(new Error('Razorpay request timed out.')));request.on('error',reject);if(body)request.write(body);request.end();
  });
}
async function saveOrder(order){
  if(databaseEnabled){await supabaseRequest('store_orders',{method:'POST',body:{id:order.id,customer_email:normalizeEmail(order.customer.email),data:order,created_at:order.createdAt},prefer:'return=minimal'});return;}
  const dataDir=path.join(PROJECT_ROOT,'data');fs.mkdirSync(dataDir,{recursive:true});
  const file=path.join(dataDir,'orders.json');let orders=[];
  try{const parsed=JSON.parse(fs.readFileSync(file,'utf8'));if(Array.isArray(parsed))orders=parsed;}catch{}
  orders.unshift(order);const temp=`${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp,JSON.stringify(orders.slice(0,500),null,2),{mode:0o600});fs.renameSync(temp,file);
}
function readPrivateList(filename){try{const parsed=JSON.parse(fs.readFileSync(path.join(PROJECT_ROOT,'data',filename),'utf8'));return Array.isArray(parsed)?parsed:[];}catch{return[];}}
function writePrivateList(filename,rows){const dir=path.join(PROJECT_ROOT,'data');fs.mkdirSync(dir,{recursive:true,mode:0o700});const file=path.join(dir,filename),temp=`${file}.${process.pid}.tmp`;fs.writeFileSync(temp,JSON.stringify(rows,null,2),{mode:0o600});fs.renameSync(temp,file);}
function normalizeEmail(value){return cleanField(value,160).toLowerCase();}
async function supabaseRequest(table,{method='GET',params={},body,prefer}={}){
  if(!databaseEnabled)throw new Error('Supabase is not configured.');
  const url=new URL(`/rest/v1/${table}`,`${supabaseUrl}/`);for(const [key,value] of Object.entries(params))url.searchParams.set(key,value);
  const response=await fetch(url,{method,headers:{apikey:supabaseKey,Authorization:`Bearer ${supabaseKey}`,'Content-Type':'application/json',...(prefer?{Prefer:prefer}:{})},...(body!==undefined?{body:JSON.stringify(body)}:{})});
  if(!response.ok)throw new Error(`Supabase database request failed (${response.status}).`);
  const raw=await response.text();return raw?JSON.parse(raw):null;
}
async function savePendingPayment(id,pending){
  if(!databaseEnabled){pendingOrders.set(id,pending);const expiry=setTimeout(()=>pendingOrders.delete(id),20*60*1000);expiry.unref?.();return;}
  await supabaseRequest('store_pending_payments',{method:'POST',body:{razorpay_order_id:id,owner_id:pending.ownerId,owner_email:normalizeEmail(pending.ownerEmail),data:pending,expires_at:new Date(pending.createdAt?Date.parse(pending.createdAt)+20*60*1000:Date.now()+20*60*1000).toISOString()},prefer:'return=minimal'});
}
async function findPendingPayment(id){
  if(!databaseEnabled)return pendingOrders.get(id)||null;
  const rows=await supabaseRequest('store_pending_payments',{params:{select:'data,expires_at',razorpay_order_id:`eq.${id}`,limit:'1'}});const row=rows[0];if(!row||Date.parse(row.expires_at)<=Date.now())return null;return row.data;
}
async function deletePendingPayment(id){
  if(!databaseEnabled){pendingOrders.delete(id);return;}
  await supabaseRequest('store_pending_payments',{method:'DELETE',params:{razorpay_order_id:`eq.${id}`},prefer:'return=minimal'});
}
async function getAuthChallenge(email){
  if(!databaseEnabled)return authChallenges.get(email)||null;
  const rows=await supabaseRequest('store_auth_challenges',{params:{select:'data,expires_at',email:`eq.${normalizeEmail(email)}`,limit:'1'}});const row=rows[0];if(!row||Date.parse(row.expires_at)<=Date.now())return null;return row.data;
}
async function saveAuthChallenge(email,challenge){
  if(!databaseEnabled){authChallenges.set(email,challenge);return;}
  await supabaseRequest('store_auth_challenges',{method:'POST',body:{email:normalizeEmail(email),data:challenge,expires_at:new Date(challenge.expiresAt).toISOString()},prefer:'return=minimal'});
}
async function updateAuthChallenge(email,challenge){
  if(!databaseEnabled){authChallenges.set(email,challenge);return;}
  await supabaseRequest('store_auth_challenges',{method:'PATCH',params:{email:`eq.${normalizeEmail(email)}`},body:{data:challenge,expires_at:new Date(challenge.expiresAt).toISOString()},prefer:'return=minimal'});
}
async function deleteAuthChallenge(email){
  if(!databaseEnabled){authChallenges.delete(email);return;}
  await supabaseRequest('store_auth_challenges',{method:'DELETE',params:{email:`eq.${normalizeEmail(email)}`},prefer:'return=minimal'});
}
async function findStoreUser(email){if(databaseEnabled){const rows=await supabaseRequest('store_users',{params:{select:'id,name,email,salt,password_hash,created_at',email:`eq.${normalizeEmail(email)}`,limit:'1'}});return rows[0]||null;}return readPrivateList('users.json').find(user=>user.email===normalizeEmail(email))||null;}
async function insertStoreUser(user){if(databaseEnabled){await supabaseRequest('store_users',{method:'POST',body:user,prefer:'return=minimal'});return;}const users=readPrivateList('users.json');users.push(user);writePrivateList('users.json',users);}
const INVENTORY_ROW_ID='__mlang_inventory__';
function defaultStock(){return Object.fromEntries(Object.values(PRODUCTS_BY_ID).map(product=>[product.id,product.stock]));}
async function getInventory(){if(databaseEnabled){const rows=await supabaseRequest('store_orders',{params:{select:'data',id:`eq.${INVENTORY_ROW_ID}`,limit:'1'}});const saved=rows[0]?.data?.stock;return {...defaultStock(),...(saved&&typeof saved==='object'?saved:{})};}try{const saved=JSON.parse(fs.readFileSync(path.join(PROJECT_ROOT,'data','inventory.json'),'utf8'));return {...defaultStock(),...(saved&&typeof saved==='object'?saved:{})};}catch{return defaultStock();}}
async function saveInventory(stock,adminEmail){if(databaseEnabled){await supabaseRequest('store_orders',{method:'POST',params:{on_conflict:'id'},body:{id:INVENTORY_ROW_ID,customer_email:normalizeEmail(adminEmail),data:{type:'internal_inventory',stock},created_at:new Date().toISOString()},prefer:'resolution=merge-duplicates,return=minimal'});return;}writePrivateList('inventory.json',stock);}
async function getStoreOrders({email,id,limit}={}){if(id===INVENTORY_ROW_ID)return [];if(databaseEnabled){const params={select:'id,customer_email,data,created_at',order:'created_at.desc',limit:String(limit||500),id:`neq.${INVENTORY_ROW_ID}`};if(email)params.customer_email=`eq.${normalizeEmail(email)}`;if(id)params.id=`eq.${id}`;const rows=await supabaseRequest('store_orders',{params});return rows.map(row=>row.data);}let rows=readPrivateList('orders.json').filter(order=>order.id!==INVENTORY_ROW_ID);if(email)rows=rows.filter(order=>normalizeEmail(order.customer?.email)===normalizeEmail(email));if(id)rows=rows.filter(order=>order.id===id);return rows.slice(0,limit||500);}
async function updateOrderEmailStatus(order){if(databaseEnabled){await supabaseRequest('store_orders',{method:'PATCH',params:{id:`eq.${order.id}`},body:{data:order},prefer:'return=minimal'});return;}const orders=readPrivateList('orders.json');const saved=orders.find(item=>item.id===order.id);if(saved){saved.emailStatus=order.emailStatus;writePrivateList('orders.json',orders);}}
async function updateStoreOrder(order){if(databaseEnabled){await supabaseRequest('store_orders',{method:'PATCH',params:{id:`eq.${order.id}`},body:{data:order},prefer:'return=minimal'});return;}const orders=readPrivateList('orders.json');const index=orders.findIndex(item=>item.id===order.id);if(index>=0){orders[index]=order;writePrivateList('orders.json',orders);}}
function isAdmin(session){return Boolean(session&&adminEmails.has(normalizeEmail(session.email)));}
function orderSummary(order){return {id:order.id,receipt:order.receipt,status:order.status,paymentMethod:order.paymentMethod||'Prepaid',subtotal:order.subtotal,discount:order.discount,gst:order.gst||0,total:order.total,createdAt:order.createdAt,itemCount:order.items?.reduce((sum,item)=>sum+item.qty,0)||0,items:(order.items||[]).map(item=>({name:item.name,sku:item.sku,size:item.size,qty:item.qty,unitPrice:item.unitPrice,lineTotal:item.lineTotal})),shipping:{status:order.shipping?.status||'pending',awb:order.shipping?.awb||null,message:order.shipping?.message||null,charge:Number.isFinite(order.shippingCharge)?order.shippingCharge:null,courier:order.selectedCourierName||null},emailStatus:order.emailStatus||'unknown'};}
function htmlEscape(value){return String(value??'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));}
async function sendEmail({to,subject,html,text}){
  if(!emailEnabled)return {status:'pending_setup'};
  try{const response=await fetch('https://api.resend.com/emails',{method:'POST',headers:{Authorization:`Bearer ${resendApiKey}`,'Content-Type':'application/json'},body:JSON.stringify({from:emailFrom,to:[to],subject,html,text})});if(!response.ok)return {status:'failed'};return {status:'sent'};}catch{return {status:'failed'};}
}
function sessionSecret(){return process.env.AUTH_SESSION_SECRET||supabaseKey||keySecret||adminPasswordHash;}
function signSession(payload){const encoded=Buffer.from(JSON.stringify(payload)).toString('base64url'),signature=crypto.createHmac('sha256',sessionSecret()).update(encoded).digest('base64url');return `${encoded}.${signature}`;}
function readSignedSession(token){try{if(!sessionSecret())return null;const [encoded,signature]=token.split('.');if(!encoded||!signature)return null;const expected=crypto.createHmac('sha256',sessionSecret()).update(encoded).digest('base64url');if(!crypto.timingSafeEqual(Buffer.from(signature),Buffer.from(expected)))return null;const session=JSON.parse(Buffer.from(encoded,'base64url').toString('utf8'));return session.expiresAt>Date.now()?session:null;}catch{return null;}}
function sessionFor(req){const cookie=String(req.headers.cookie||'').split(';').map(part=>part.trim()).find(part=>part.startsWith('mlang_session='));const token=cookie?.slice('mlang_session='.length);if(!token)return null;if(process.env.VERCEL==='1')return readSignedSession(token);const session=sessions.get(token);if(!session||session.expiresAt<Date.now()){sessions.delete(token);return null;}return session;}
function guestFor(req){const token=String(req.headers.cookie||'').split(';').map(part=>part.trim()).find(part=>part.startsWith('mlang_guest='))?.slice('mlang_guest='.length);const guest=token?readSignedSession(token):null;return guest?.guestId?guest:null;}
function setGuestCookie(res){const guest={guestId:crypto.randomUUID(),expiresAt:Date.now()+30*60*1000};const token=signSession(guest);res.setHeader('Set-Cookie',`mlang_guest=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=1800${publicHttpsUrl(publicStoreUrl)||process.env.VERCEL==='1'?'; Secure':''}`);return guest;}
function setSession(res,user){const session={userId:user.id,email:user.email,name:user.name,expiresAt:Date.now()+30*24*60*60*1000};if(process.env.VERCEL==='1'&&!sessionSecret())throw new Error('Set a stable AUTH_SESSION_SECRET in Vercel settings.');const token=process.env.VERCEL==='1'?signSession(session):crypto.randomBytes(32).toString('base64url');if(process.env.VERCEL!=='1')sessions.set(token,session);res.setHeader('Set-Cookie',`mlang_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=2592000${publicHttpsUrl(publicStoreUrl)||process.env.VERCEL==='1'?'; Secure':''}`);}
function publicUser(user){return {id:user.id,name:user.name,email:user.email,role:adminEmails.has(normalizeEmail(user.email))?'admin':'customer'};}
function safeCompareHex(a,b){try{const x=Buffer.from(a,'hex'),y=Buffer.from(b,'hex');return x.length===y.length&&x.length>0&&crypto.timingSafeEqual(x,y);}catch{return false;}}
function verifyAdminPassword(password,email=''){
  const configuredHash=adminPasswordHashes.get(normalizeEmail(email))||adminPasswordHash;
  const match=configuredHash.match(/^scrypt\$([a-f0-9]{32})\$([a-f0-9]{128})$/i);if(!match||password.length>128)return false;
  const submitted=crypto.scryptSync(password,match[1],64).toString('hex');return safeCompareHex(match[2],submitted);
}
async function shiprocketToken(){
  if(shiprocketAuthCache.token&&shiprocketAuthCache.expiresAt>Date.now())return shiprocketAuthCache.token;
  const response=await fetch(`${shiprocketBase}/auth/login`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email:shiprocketEmail,password:shiprocketPassword}),signal:AbortSignal.timeout(12000)});
  const data=await response.json().catch(()=>({}));
  if(!response.ok||!data.token)throw new Error('Shiprocket login failed. Check the API user email/password and account access.');
  shiprocketAuthCache={token:data.token,expiresAt:Date.now()+8*24*60*60*1000};
  return data.token;
}
async function shiprocketRequest(route,{method='GET',body}={}){
  const token=await shiprocketToken();
  const response=await fetch(`${shiprocketBase}${route}`,{method,headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json',...(body?{'Accept':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(15000)});
  const data=await response.json().catch(()=>({}));
  if(!response.ok)throw new Error(cleanField(data.message||data.errors||`Shiprocket returned HTTP ${response.status}.`,300));
  return data;
}
function packedWeight(items){return Math.round(packageDimensions.weight*items.reduce((sum,item)=>sum+item.qty,0)*1000)/1000;}
async function shiprocketPickupPostcode(){
  if(shiprocketPickupPostcodeCache.value&&shiprocketPickupPostcodeCache.expiresAt>Date.now())return shiprocketPickupPostcodeCache.value;
  const data=await shiprocketRequest('/settings/company/pickup');
  const locations=data.data?.shipping_address||data.shipping_address||[];
  const location=locations.find(item=>(item.pickup_location||item.name)===shiprocketPickup);
  const postcode=String(location?.pin_code||location?.pincode||location?.pickup_pincode||'');
  if(!/^\d{6}$/.test(postcode))throw new Error('Could not read the configured Shiprocket pickup PIN code. Check the active pickup location.');
  shiprocketPickupPostcodeCache={value:postcode,expiresAt:Date.now()+10*60*1000};
  return postcode;
}
function signShippingQuote(quote){
  const payload=Buffer.from(JSON.stringify(quote)).toString('base64url');
  const signature=crypto.createHmac('sha256',shiprocketPassword).update(payload).digest('base64url');
  return `${payload}.${signature}`;
}
function verifyShippingQuote(token,{items,coupon,pincode,paymentMethod}){
  if(typeof token!=='string'||token.length>3000)throw new Error('Shipping quote expired. Please refresh the delivery estimate.');
  const [payload,signature,...extra]=token.split('.');
  const expected=crypto.createHmac('sha256',shiprocketPassword).update(payload||'').digest();
  let supplied;try{supplied=Buffer.from(signature||'','base64url');}catch{supplied=Buffer.alloc(0);}
  if(extra.length||expected.length!==supplied.length||!crypto.timingSafeEqual(expected,supplied))throw new Error('Shipping quote is invalid. Please refresh the delivery estimate.');
  let quote;try{quote=JSON.parse(Buffer.from(payload,'base64url').toString('utf8'));}catch{throw new Error('Shipping quote is invalid. Please refresh the delivery estimate.');}
  const itemKey=items.map(item=>`${item.id}:${item.size}:${item.qty}`).join('|');
  if(quote.expiresAt<Date.now()||quote.pincode!==pincode||quote.coupon!==coupon||quote.paymentMethod!==paymentMethod||quote.itemKey!==itemKey||!Number.isSafeInteger(quote.amount)||quote.amount<0||!Number.isInteger(quote.courierId))throw new Error('Shipping quote changed or expired. Please check the delivery estimate again.');
  return quote;
}
async function getShippingQuote({items,coupon,pincode,paymentMethod,declaredValue}){
  if(!shiprocketEnabled)throw new Error('Live Shiprocket shipping rates are unavailable. Please contact the store.');
  if(!/^\d{6}$/.test(pincode))throw new Error('Enter a valid 6-digit delivery PIN code to calculate shipping.');
  if(!['COD','Prepaid'].includes(paymentMethod))throw new Error('Select a valid payment method to calculate shipping.');
  const pickupPostcode=await shiprocketPickupPostcode(),weight=packedWeight(items);
  const params=new URLSearchParams({pickup_postcode:pickupPostcode,delivery_postcode:pincode,cod:paymentMethod==='COD'?'1':'0',weight:String(weight),length:String(packageDimensions.length),breadth:String(packageDimensions.breadth),height:String(packageDimensions.height),declared_value:String(Math.max(1,declaredValue))});
  const response=await shiprocketRequest(`/courier/serviceability/?${params}`);
  const couriers=response.data?.available_courier_companies||response.available_courier_companies||[];
  const eligible=couriers.map(item=>{
    const rate=Number(item.rate),extraCharges=['freight_charge','cod_charges','other_charges','coverage_charges','pickup_suppression_charges'].reduce((sum,key)=>sum+(Number.isFinite(Number(item[key]))?Number(item[key]):0),0);
    return {id:Number(item.courier_company_id),name:cleanField(item.courier_name||'Courier',100),rate:Number.isFinite(rate)&&rate>0?rate:extraCharges,days:cleanField(item.estimated_delivery_days||item.etd||'',40),cod:item.cod};
  }).filter(item=>Number.isInteger(item.id)&&Number.isFinite(item.rate)&&item.rate>0&&(paymentMethod!=='COD'||String(item.cod)==='1'));
  eligible.sort((a,b)=>a.rate-b.rate);
  const selected=eligible[0];
  if(!selected)throw new Error('Shiprocket has no serviceable courier for this PIN code and payment method. Check the PIN or contact the store.');
  const amount=Math.ceil(selected.rate),itemKey=items.map(item=>`${item.id}:${item.size}:${item.qty}`).join('|');
  const quote={amount,courierId:selected.id,courierName:selected.name,estimatedDays:selected.days,pincode,coupon,paymentMethod,itemKey,expiresAt:Date.now()+20*60*1000};
  return {...quote,token:signShippingQuote(quote)};
}
async function trackShiprocket(awb){
  if(!shiprocketEnabled)return {status:'pending_setup',timeline:[]};
  try{
    const data=await shiprocketRequest(`/courier/track/awb/${encodeURIComponent(awb)}`);
    const tracking=data.tracking_data||data.data?.tracking_data||data.data||{};
    const activities=Array.isArray(tracking.shipment_track_activities)?tracking.shipment_track_activities:[];
    const latest=Array.isArray(tracking.shipment_track)?tracking.shipment_track[0]:null;
    return {status:cleanField(latest?.current_status||tracking.shipment_status||tracking.track_status||data.message||'Tracking update',80),timeline:activities.slice(0,30).map(event=>({time:cleanField(event.date||event.updated_at||event.created_at,80),location:cleanField(event.location||event.activity_location,100),status:cleanField(event.activity||event.status||event.status_description,180)}))};
  }catch{return {status:'tracking_unavailable',timeline:[]};}
}
async function sendOrderEmail(order){
  const lines=order.items.map(item=>`<li>${htmlEscape(item.name)} · size ${htmlEscape(item.size)} × ${item.qty} — ₹${item.lineTotal.toLocaleString('en-IN')}</li>`).join('');
  const awb=order.shipping?.awb?`Shiprocket AWB: ${htmlEscape(order.shipping.awb)}`:'Shipment tracking will appear in your M’LANG account after a label is created.';
  const cod=order.paymentMethod==='COD',paymentLine=cod?'Payment: Cash on delivery. Please pay the courier on delivery.':'Payment: captured online.';
  const text=`Thanks for your M’LANG order ${order.id}.\n${order.items.map(item=>`${item.name} · ${item.size} × ${item.qty}`).join('\n')}\nGST (5%): ₹${order.gst||0}\nShipping: ₹${order.shippingCharge||0}\nTotal: ₹${order.total}\n${paymentLine}\n${awb}\nOrder updates: ${publicStoreUrl}/#orders`;
  return sendEmail({to:order.customer.email,subject:`M’LANG order received · ${order.id}`,text,html:`<div style="font-family:Arial,sans-serif;color:#171716;max-width:600px;margin:auto"><p style="letter-spacing:.16em">M’LANG</p><h1>Order received.</h1><p>Thanks, ${htmlEscape(order.customer.name)}. Your order <strong>${htmlEscape(order.id)}</strong> has been received.</p><ul>${lines}</ul><p>GST (5%): ₹${(order.gst||0).toLocaleString('en-IN')}<br>Shipping: ₹${(order.shippingCharge||0).toLocaleString('en-IN')}</p><p><strong>Total: ₹${order.total.toLocaleString('en-IN')}</strong></p><p>${htmlEscape(paymentLine)}</p><p>${awb}</p><p><a href="${htmlEscape(publicStoreUrl)}/#orders">View order updates</a></p></div>`});
}
async function bookShiprocket(order){
  if(!shiprocketEnabled)return {provider:'Shiprocket',status:'pending_setup',message:'Add Shiprocket API user credentials, the configured pickup-location name, and packed parcel dimensions/weight in .env.'};
  const customer=order.customer,nameParts=customer.name.trim().split(/\s+/),firstName=nameParts.shift()||customer.name,lastName=nameParts.join(' ');
  const orderDate=new Date(order.createdAt).toISOString().slice(0,16).replace('T',' ');
  const cod=order.paymentMethod==='COD';
  const shippingCharge=Number.isFinite(order.shippingCharge)?order.shippingCharge:(typeof order.shipping==='number'?order.shipping:Math.max(0,Number(order.total)-Number(order.subtotal)+Number(order.discount||0)));
  const payload={order_id:order.id,order_date:orderDate,pickup_location:shiprocketPickup,comment:`M’LANG ${cod?'COD':'prepaid'} website order`,billing_customer_name:firstName,billing_last_name:lastName,billing_address:customer.address,billing_city:customer.city,billing_pincode:customer.pincode,billing_state:customer.state,billing_country:'India',billing_email:customer.email,billing_phone:customer.phone.replace(/\D/g,'').slice(-10),shipping_is_billing:1,order_items:order.items.map(item=>({name:item.name,sku:item.sku,units:item.qty,selling_price:item.unitPrice,discount:0})),payment_method:cod?'COD':'Prepaid',shipping_charges:shippingCharge,total_discount:order.discount,sub_total:order.subtotal-order.discount,length:packageDimensions.length,breadth:packageDimensions.breadth,height:packageDimensions.height,weight:packedWeight(order.items)};
  let shipmentId='',shiprocketOrderId='';
  try{
    const created=await shiprocketRequest('/orders/create/adhoc',{method:'POST',body:payload});
    shipmentId=created.shipment_id||created.data?.shipment_id||'';shiprocketOrderId=created.order_id||created.data?.order_id||'';
    if(!shipmentId)throw new Error(cleanField(created.message||'Shiprocket created no shipment ID.',300));
    const assigned=await shiprocketRequest('/courier/assign/awb',{method:'POST',body:{shipment_id:shipmentId,...(order.selectedCourierId?{courier_company_id:order.selectedCourierId}:{})}});
    const assignment=assigned.response?.data||assigned.data||assigned;
    const awb=assignment.awb_code||assignment.awb||assignment.awb_number;
    if(!awb)throw new Error(cleanField(assignment.awb_assign_error||assigned.message||'Shiprocket did not assign an AWB.',300));
    let pickupStatus='scheduled',pickupMessage='';
    try{const pickup=await shiprocketRequest('/courier/generate/pickup',{method:'POST',body:{shipment_id:[shipmentId]}});pickupMessage=cleanField(pickup.message||'',180);}
    catch(error){pickupStatus='pending';pickupMessage=cleanField(error.message,180);}
    return {provider:'Shiprocket',status:'booked',awb:String(awb),carrierStatus:cleanField(assignment.courier_name||'AWB assigned',80),shiprocketOrderId:String(shiprocketOrderId||''),shipmentId:String(shipmentId),pickupStatus,pickupMessage};
  }catch(error){return {provider:'Shiprocket',status:'booking_failed',message:cleanField(error.message||'Shiprocket could not book this shipment.',300),...(shipmentId?{shipmentId:String(shipmentId)}:{}),...(shiprocketOrderId?{shiprocketOrderId:String(shiprocketOrderId)}:{})};}
}

async function handleRequest(req,res){
  const host=req.headers.host||'';
  if(!allowedHosts().has(host)){send(res,403,{error:'This host is not configured for the M’LANG store.'});return;}
  if(req.method!=='GET'&&req.method!=='HEAD'&&req.headers.origin&&!allowedOrigins().has(req.headers.origin)){send(res,403,{error:'Request origin is not allowed.'});return;}
  const pathname=new URL(req.url,'http://localhost').pathname;
  if(req.method==='GET'&&pathname==='/api/config'){send(res,200,{razorpayEnabled:paymentsEnabled,keyId:paymentsEnabled?keyId:null,mode:paymentsEnabled?razorpayMode:'unconfigured',codEnabled:process.env.VERCEL!=='1'||databaseEnabled,shiprocketEnabled,emailEnabled,databaseEnabled,gstEnabled:gstRegistered});return;}
  if(req.method==='POST'&&pathname==='/api/shipping/quote'){
    const now=Date.now(),ip=String(req.headers['x-forwarded-for']||'unknown').split(',')[0].trim(),attempts=(shippingQuoteAttempts.get(ip)||[]).filter(time=>now-time<60_000);
    if(attempts.length>=12){send(res,429,{error:'Too many shipping checks. Wait a minute and try again.'});return;}
    attempts.push(now);shippingQuoteAttempts.set(ip,attempts);
    try{
      const body=await readJson(req),coupon=body.coupon==='WELCOME10'?'WELCOME10':'',totals=priceCart(body.items,coupon,await getInventory()),pincode=cleanField(body.pincode,6),paymentMethod=body.paymentMethod==='COD'?'COD':'Prepaid';
      send(res,200,{quote:await getShippingQuote({items:totals.items,coupon,pincode,paymentMethod,declaredValue:totals.subtotal-totals.discount+totals.gst})});
    }catch(error){send(res,400,{error:error.message||'Could not calculate shipping for this PIN code.'});}
    return;
  }
  if(req.method==='GET'&&pathname==='/api/auth/me'){const session=sessionFor(req);send(res,200,{user:session?publicUser({id:session.userId,name:session.name,email:session.email}):null});return;}
  if(req.method==='POST'&&pathname==='/api/auth/register'){
    if(process.env.VERCEL==='1'&&!databaseEnabled){send(res,503,{error:'Connect Supabase before enabling customer accounts on Vercel.'});return;}
    if(!emailEnabled){send(res,503,{error:'Account email verification is not configured yet. Add Resend credentials and a verified sender in .env.'});return;}
    try{const body=await readJson(req),name=cleanField(body.name,100),email=normalizeEmail(body.email),password=String(body.password||'');if(name.length<2||!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)||password.length<10||password.length>128)throw new Error('Enter your name, a valid email, and a password of 10–128 characters.');if(await findStoreUser(email)){send(res,409,{error:'An account with this email already exists. Sign in instead.'});return;}const existing=await getAuthChallenge(email);if(existing&&existing.sentAt>Date.now()-60000){send(res,429,{error:'Please wait a minute before requesting another verification email.'});return;}const code=String(crypto.randomInt(0,1000000)).padStart(6,'0'),salt=crypto.randomBytes(16).toString('hex'),passwordHash=crypto.scryptSync(password,salt,64).toString('hex');const result=await sendEmail({to:email,subject:'Verify your M’LANG account',text:`Your M’LANG verification code is ${code}. It expires in 10 minutes.`,html:`<div style="font-family:Arial,sans-serif;color:#171716"><p>M’LANG account verification</p><h1>${code}</h1><p>This code expires in 10 minutes.</p></div>`});if(result.status!=='sent'){send(res,502,{error:'Could not send the verification email. Check the mail provider configuration and try again.'});return;}await saveAuthChallenge(email,{name,email,salt,passwordHash,codeHash:crypto.createHash('sha256').update(code).digest('hex'),expiresAt:Date.now()+10*60*1000,sentAt:Date.now(),attempts:0});send(res,200,{verificationRequired:true,email});}catch(error){send(res,400,{error:error.message||'Could not start account registration.'});}return;
  }
  if(req.method==='POST'&&pathname==='/api/auth/verify'){
    try{const body=await readJson(req),email=normalizeEmail(body.email),code=cleanField(body.code,6),challenge=await getAuthChallenge(email);if(!challenge||challenge.expiresAt<Date.now()||challenge.attempts>=5){await deleteAuthChallenge(email);send(res,400,{error:'Verification code expired. Start registration again.'});return;}challenge.attempts++;await updateAuthChallenge(email,challenge);const submitted=crypto.createHash('sha256').update(code).digest('hex');if(!safeCompareHex(challenge.codeHash,submitted)){send(res,400,{error:'That verification code is incorrect.'});return;}if(await findStoreUser(email)){await deleteAuthChallenge(email);send(res,409,{error:'An account with this email already exists. Sign in instead.'});return;}const user={id:crypto.randomUUID(),name:challenge.name,email,salt:challenge.salt,passwordHash:challenge.passwordHash,createdAt:new Date().toISOString()};await insertStoreUser({id:user.id,name:user.name,email:user.email,salt:user.salt,password_hash:user.passwordHash,created_at:user.createdAt});await deleteAuthChallenge(email);setSession(res,user);send(res,201,{user:publicUser(user)});}catch(error){send(res,400,{error:error.message||'Could not verify the account.'});}return;
  }
  if(req.method==='POST'&&pathname==='/api/auth/login'){
    try{const body=await readJson(req),email=normalizeEmail(body.email),password=String(body.password||'');if(adminEmails.has(email)&&verifyAdminPassword(password,email)){const user={id:`store-admin:${email}`,name:'THE MALANG COMPANY',email};setSession(res,user);send(res,200,{user:publicUser(user)});return;}const user=await findStoreUser(email);if(!user||password.length>128||!safeCompareHex(user.password_hash||user.passwordHash,crypto.scryptSync(password,user.salt,64).toString('hex'))){send(res,401,{error:'Email or password is incorrect.'});return;}setSession(res,user);send(res,200,{user:publicUser(user)});}catch(error){send(res,400,{error:error.message||'Could not sign in.'});}return;
  }
  if(req.method==='POST'&&pathname==='/api/auth/logout'){const sessionToken=String(req.headers.cookie||'').split(';').map(part=>part.trim()).find(part=>part.startsWith('mlang_session='))?.slice('mlang_session='.length);if(sessionToken)sessions.delete(sessionToken);res.setHeader('Set-Cookie','mlang_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0');send(res,200,{ok:true});return;}
  if(req.method==='GET'&&pathname==='/api/account/orders'){
    const session=sessionFor(req);if(!session){send(res,401,{error:'Please sign in to view your orders.'});return;}try{const orders=(await getStoreOrders({email:session.email,limit:200})).map(orderSummary);send(res,200,{orders});}catch(error){send(res,503,{error:error.message||'Could not load account orders.'});}return;
  }
  if(req.method==='GET'&&pathname==='/api/catalog'){try{send(res,200,{stocks:await getInventory()});}catch(error){send(res,503,{error:error.message||'Could not load product stock.'});}return;}
  if(req.method==='PUT'&&pathname==='/api/admin/inventory'){
    const session=sessionFor(req);if(!session||!isAdmin(session)){send(res,403,{error:'Admin access is required.'});return;}
    try{const body=await readJson(req),stock=await getInventory();if(!body.stock||typeof body.stock!=='object'||Array.isArray(body.stock)){send(res,400,{error:'Provide stock counts for each product.'});return;}for(const [id,value] of Object.entries(body.stock)){if(!PRODUCTS_BY_ID[id]||!Number.isInteger(value)||value<0||value>999){send(res,400,{error:'Stock must be a whole number from 0 to 999 for a listed product.'});return;}stock[id]=value;}await saveInventory(stock,session.email);send(res,200,{stocks:stock});}catch(error){send(res,503,{error:error.message||'Could not save product stock.'});}return;
  }
  if(req.method==='GET'&&pathname==='/api/admin/orders'){
    const session=sessionFor(req);if(!session||!isAdmin(session)){send(res,403,{error:'Admin access is required.'});return;}try{const orders=(await getStoreOrders({limit:500})).map(order=>({...orderSummary(order),customer:order.customer||{},paymentId:order.paymentId||null,razorpayOrderId:order.razorpayOrderId||null}));send(res,200,{orders});}catch(error){send(res,503,{error:error.message||'Could not load store orders.'});}return;
  }
  const retryShipmentMatch=pathname.match(/^\/api\/admin\/orders\/([^/]+)\/retry-shipment$/);
  if(req.method==='POST'&&retryShipmentMatch){
    const session=sessionFor(req);if(!session||!isAdmin(session)){send(res,403,{error:'Admin access is required.'});return;}
    if(!shiprocketEnabled){send(res,503,{error:'Shiprocket is not configured for this deployment.'});return;}
    let orderId;try{orderId=decodeURIComponent(retryShipmentMatch[1]);}catch{send(res,400,{error:'Invalid order ID.'});return;}
    if(shipmentRetryLocks.has(orderId)){send(res,409,{error:'A shipment retry is already running for this order.'});return;}
    try{
      const order=(await getStoreOrders({id:orderId,limit:1}))[0];if(!order){send(res,404,{error:'Order not found.'});return;}
      if(!['paid','cod_ordered'].includes(order.status)){send(res,409,{error:'Only paid or COD orders can be sent to Shiprocket.'});return;}
      if(order.shipping?.status!=='booking_failed'){send(res,409,{error:'This order does not have a failed shipment booking.'});return;}
      if(order.shipping?.awb||order.shipping?.shipmentId||order.shipping?.shiprocketOrderId){send(res,409,{error:'Shiprocket already created a shipment for this order. Check the Shiprocket dashboard before retrying.'});return;}
      shipmentRetryLocks.add(orderId);
      order.shipping={provider:'Shiprocket',status:'retrying',message:'Shipment retry in progress.'};
      await updateStoreOrder(order);
      order.shipping=await bookShiprocket(order);
      await updateStoreOrder(order);
      const status=order.shipping.status==='booked'?200:502;
      send(res,status,{order:orderSummary(order)});
    }catch(error){
      let order;
      try{order=(await getStoreOrders({id:orderId,limit:1}))[0];if(order&&order.shipping?.status==='retrying'){order.shipping={provider:'Shiprocket',status:'booking_failed',message:cleanField(error.message||'Could not save the shipment result.',240)};await updateStoreOrder(order);}}catch{}
      send(res,503,{error:error.message||'Could not retry Shiprocket booking.'});
    }finally{shipmentRetryLocks.delete(orderId);}
    return;
  }
  const trackMatch=pathname.match(/^\/api\/account\/orders\/([^/]+)\/tracking$/);
  if(req.method==='GET'&&trackMatch){const session=sessionFor(req);if(!session){send(res,401,{error:'Please sign in to track an order.'});return;}const id=decodeURIComponent(trackMatch[1]);try{const order=(await getStoreOrders({email:session.email,limit:500})).find(item=>item.id===id);if(!order){send(res,404,{error:'Order not found.'});return;}if(!order.shipping?.awb){send(res,200,{status:order.shipping?.status||'pending_setup',message:order.shipping?.message||'Shiprocket AWB is not available yet.',timeline:[]});return;}send(res,200,await trackShiprocket(order.shipping.awb));}catch(error){send(res,503,{error:error.message||'Tracking is unavailable.'});}return;}
  if(req.method==='POST'&&pathname==='/api/razorpay/orders'){
    if(!paymentsEnabled){send(res,503,{error:'Razorpay is not configured for this environment.'});return;}
    try{
      const body=await readJson(req),coupon=body.coupon==='WELCOME10'?'WELCOME10':'',totals=priceCart(body.items,coupon,await getInventory());
      const customer=validateCustomer(body.customer);
      const quote=verifyShippingQuote(body.shippingQuote,{items:totals.items,coupon,pincode:customer.pincode,paymentMethod:'Prepaid'});totals.shipping=quote.amount;totals.total=totals.subtotal-totals.discount+totals.gst+totals.shipping;
      if(body.policyAccepted!==true){send(res,400,{error:'Please acknowledge the store contact and exchange policy before placing your order.'});return;}
      const session=sessionFor(req);if(session&&normalizeEmail(customer.email)!==session.email){send(res,403,{error:'Use the email address on your signed-in account for this order.'});return;}
      const guest=session?null:(guestFor(req)||setGuestCookie(res));
      const receipt=`mlang_${crypto.randomUUID().replaceAll('-','').slice(0,24)}`;
      const remote=await razorpayRequest('POST','/orders',{amount:totals.total*100,currency:'INR',receipt,notes:{store:'MLANG',environment:razorpayMode}});
      await savePendingPayment(remote.id,{receipt,razorpayOrderId:remote.id,...totals,selectedCourierId:quote.courierId,selectedCourierName:quote.courierName,customer,ownerEmail:session?.email||normalizeEmail(customer.email),ownerId:session?.userId||guest.guestId,ownerType:session?'account':'guest',createdAt:new Date().toISOString()});
      send(res,201,{keyId,orderId:remote.id,amount:remote.amount,currency:remote.currency,receipt,mode:razorpayMode});
    }catch(error){send(res,400,{error:error.message||'Could not create a payment order.'});}
    return;
  }
  if(req.method==='POST'&&pathname==='/api/razorpay/verify'){
    if(!paymentsEnabled){send(res,503,{error:'Razorpay payments are not configured for this environment.'});return;}
    const session=sessionFor(req),guest=guestFor(req);if(!session&&!guest){send(res,401,{error:'Checkout session expired. Please restart checkout.'});return;}
    try{
      const body=await readJson(req),orderId=cleanField(body.razorpay_order_id,100),paymentId=cleanField(body.razorpay_payment_id,100),signature=cleanField(body.razorpay_signature,128);
      const pending=await findPendingPayment(orderId),ownsPending=pending&&(pending.ownerType==='guest'?guest?.guestId===pending.ownerId:session?.email===pending.ownerEmail&&session?.userId===pending.ownerId);if(!pending||!ownsPending||!paymentId||!signature||normalizeEmail(body.customer?.email)!==pending.ownerEmail){send(res,400,{error:'Payment confirmation could not be matched to this checkout.'});return;}
      const expected=crypto.createHmac('sha256',keySecret).update(`${pending.razorpayOrderId}|${paymentId}`).digest('hex');
      const a=Buffer.from(expected),b=Buffer.from(signature);if(a.length!==b.length||!crypto.timingSafeEqual(a,b)){send(res,400,{error:'Razorpay payment signature did not verify.'});return;}
      const payment=await razorpayRequest('GET',`/payments/${encodeURIComponent(paymentId)}`);
      if(payment.order_id!==pending.razorpayOrderId||payment.amount!==pending.total*100||payment.currency!=='INR'||payment.status!=='captured'){send(res,409,{error:'Payment is not captured yet. Please wait and check your Razorpay dashboard.'});return;}
      const order={id:`ML-${Date.now().toString().slice(-8)}-${crypto.randomBytes(2).toString('hex').toUpperCase()}`,receipt:pending.receipt,status:'paid',paymentMethod:'Prepaid',paymentId,razorpayOrderId:orderId,items:pending.items,subtotal:pending.subtotal,discount:pending.discount,gst:pending.gst||0,shippingCharge:pending.shipping,selectedCourierId:pending.selectedCourierId,selectedCourierName:pending.selectedCourierName,shipping:pending.shipping,total:pending.total,currency:'INR',customer:pending.customer,policyAccepted:true,createdAt:new Date().toISOString()};
      order.shipping=await bookShiprocket(order);order.emailStatus=emailEnabled?'pending':'pending_setup';await saveOrder(order);await deletePendingPayment(orderId);const emailResult=await sendOrderEmail(order);order.emailStatus=emailResult.status;try{await updateOrderEmailStatus(order);}catch(error){console.error('Could not update order email status:',error.message);}
      if(pending.ownerType==='guest')res.setHeader('Set-Cookie','mlang_guest=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0; Secure');
      send(res,200,{order:{id:order.id,receipt:order.receipt,status:order.status,total:order.total,gst:order.gst,itemCount:order.items.reduce((sum,item)=>sum+item.qty,0),shipping:order.shipping,emailStatus:order.emailStatus}});
    }catch(error){send(res,400,{error:error.message||'Payment verification failed.'});}
    return;
  }
  if(req.method==='POST'&&pathname==='/api/orders/cod'){
    if(process.env.VERCEL==='1'&&!databaseEnabled){send(res,503,{error:'Connect Supabase before accepting COD orders on Vercel.'});return;}
    try{
      const body=await readJson(req),coupon=body.coupon==='WELCOME10'?'WELCOME10':'',totals=priceCart(body.items,coupon,await getInventory());
      const customer=validateCustomer(body.customer);
      const quote=verifyShippingQuote(body.shippingQuote,{items:totals.items,coupon,pincode:customer.pincode,paymentMethod:'COD'});totals.shipping=quote.amount;totals.total=totals.subtotal-totals.discount+totals.gst+totals.shipping;
      if(body.policyAccepted!==true){send(res,400,{error:'Please acknowledge the store policy before placing your order.'});return;}
      const clientKey=crypto.createHash('sha256').update(`${normalizeEmail(customer.email)}|${customer.phone.replace(/\D/g,'')}`).digest('hex'),now=Date.now(),attempts=(codAttempts.get(clientKey)||[]).filter(time=>now-time<60*60*1000);
      if(attempts.length>=5){send(res,429,{error:'Too many COD orders from this connection. Please try again later.'});return;}
      attempts.push(now);codAttempts.set(clientKey,attempts);
      const order={id:`ML-${Date.now().toString().slice(-8)}-${crypto.randomBytes(2).toString('hex').toUpperCase()}`,receipt:`cod_${crypto.randomUUID().replaceAll('-','').slice(0,20)}`,status:'cod_ordered',paymentMethod:'COD',items:totals.items,subtotal:totals.subtotal,discount:totals.discount,gst:totals.gst,shippingCharge:totals.shipping,selectedCourierId:quote.courierId,selectedCourierName:quote.courierName,shipping:totals.shipping,total:totals.total,currency:'INR',customer,policyAccepted:true,createdAt:new Date().toISOString()};
      order.shipping=await bookShiprocket(order);order.emailStatus=emailEnabled?'pending':'pending_setup';
      await saveOrder(order);
      const emailResult=await sendOrderEmail(order);order.emailStatus=emailResult.status;try{await updateOrderEmailStatus(order);}catch(error){console.error('Could not update order email status:',error.message);}
      send(res,201,{order:{id:order.id,receipt:order.receipt,status:order.status,total:order.total,gst:order.gst,itemCount:order.items.reduce((sum,item)=>sum+item.qty,0),paymentMethod:order.paymentMethod,shipping:order.shipping,emailStatus:order.emailStatus}});
    }catch(error){send(res,400,{error:error.message||'Could not place the COD order.'});}
    return;
  }
  if(req.method!=='GET'&&req.method!=='HEAD'){send(res,405,{error:'Method not allowed.'});return;}
  let decoded;try{decoded=decodeURIComponent(pathname);}catch{res.writeHead(400);res.end('Bad request');return;}
  if(decoded.split('/').some(part=>part.startsWith('.')&&part.length>1)||decoded.startsWith('/data')){res.writeHead(404);res.end('Not found');return;}
  const target=path.resolve(PROJECT_ROOT,`.${decoded==='/'?'/index.html':decoded}`);
  if(target!==PROJECT_ROOT&&!target.startsWith(`${PROJECT_ROOT}${path.sep}`)){res.writeHead(403);res.end('Forbidden');return;}
  let stat;try{stat=fs.statSync(target);}catch{res.writeHead(404);res.end('Not found');return;}
  if(!stat.isFile()){res.writeHead(404);res.end('Not found');return;}
  res.writeHead(200,{'Content-Type':MIME[path.extname(target)]||'application/octet-stream','X-Content-Type-Options':'nosniff','Referrer-Policy':'strict-origin-when-cross-origin','Cache-Control':'no-cache'});
  if(req.method==='HEAD'){res.end();return;}fs.createReadStream(target).pipe(res);
}

export { handleRequest };
if(process.env.VERCEL!=='1'){
  const port=Number(process.env.PORT||4173),host=process.env.HOST||'127.0.0.1';
  http.createServer(handleRequest).listen(port,host,()=>console.log(`M’LANG server: http://${host}:${port}/ (${paymentsEnabled?`Razorpay ${razorpayMode} keys loaded`:'demo checkout; payment provider not configured'})`));
}
