import { PRODUCTS as PRODUCT_CATALOG, PRODUCT_SIZES, TEE_SIZE_CHART } from '../shared/catalog.js';

// Shared helpers and DOM references.
const asset = name => `public/assets/${name}`;
const money = value => `₹${Math.round(value).toLocaleString('en-IN')}`;
const escapeHtml = value => String(value??'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const readStore = (key, fallback) => { try { const value=JSON.parse(localStorage.getItem(key)); return value ?? fallback; } catch { return fallback; } };
const writeStore = (key, value) => { try { localStorage.setItem(key,JSON.stringify(value)); } catch { showToast('BROWSER STORAGE IS UNAVAILABLE'); } };
const productGrid=document.querySelector('#product-grid'), pageOverlay=document.querySelector('#overlay');
const cartDrawer=document.querySelector('#cart-drawer'), productDetailsPanel=document.querySelector('#product-modal'), checkoutPanel=document.querySelector('#checkout-modal');
const storedCart=readStore('mlang-cart',[]),storedFavorites=readStore('mlang-favorites',[]);
let cart=(Array.isArray(storedCart)?storedCart:[]).filter(item=>item&&PRODUCT_CATALOG.some(p=>p.id===item.id)&&PRODUCT_SIZES.includes(item.size)&&Number.isInteger(item.qty)&&item.qty>0).map(item=>({...item,qty:Math.min(item.qty,5)}));
let favorites=new Set((Array.isArray(storedFavorites)?storedFavorites:[]).filter(id=>PRODUCT_CATALOG.some(p=>p.id===id)));
let activeFilter='all', searchQuery='', sortMode='featured', savedView=false, appliedCoupon='';
let paymentSettings={razorpayEnabled:false,keyId:null,shiprocketEnabled:false,emailEnabled:false,databaseEnabled:false,gstEnabled:false},isPaymentInProgress=false,currentAccount=null,accountEmail='';
let toastTimer,shippingQuotes={prepaid:null,cod:null},shippingQuoteRequest=0;
const persistCart=()=>writeStore('mlang-cart',cart);
const getProductById=id=>PRODUCT_CATALOG.find(product=>product.id===id);
cart=cart.reduce((normalized,item)=>{const product=getProductById(item.id),used=normalized.reduce((sum,current)=>sum+(current.id===item.id?current.qty:0),0),available=Math.max(0,product.stock-used),qty=Math.min(item.qty,available);if(qty)normalized.push({...item,qty});return normalized;},[]);
const totalUnits=()=>cart.reduce((sum,item)=>sum+item.qty,0);
const subtotal=()=>cart.reduce((sum,item)=>sum+getProductById(item.id).price*item.qty,0);
const discount=()=>appliedCoupon==='WELCOME10'?Math.round(subtotal()*.1):0;
const gst=()=>paymentSettings.gstEnabled?Math.round((subtotal()-discount())*.05):0;

// Product grid, favorites, cart contents, and product details.
function renderProducts(){
  let list=PRODUCT_CATALOG.filter(p=>(activeFilter==='all'||p.color===activeFilter)&&p.name.toLowerCase().includes(searchQuery.toLowerCase())&&(!savedView||favorites.has(p.id)));
  if(sortMode==='price-low')list.sort((a,b)=>a.price-b.price); else if(sortMode==='price-high')list.sort((a,b)=>b.price-a.price); else if(sortMode==='name')list.sort((a,b)=>a.name.localeCompare(b.name));
  productGrid.innerHTML='';
  for(const p of list){
    const card=document.createElement('article');card.className='product-card';card.dataset.id=p.id;
    card.innerHTML=`<div class="product-image-wrap"><img class="product-image" src="${asset(p.previewImage||p.images[0])}" alt="${p.name} preview" loading="lazy"><button class="quick-add" data-quick="${p.id}">VIEW PIECE <span>↗</span></button><button class="favorite-button ${favorites.has(p.id)?'is-favorite':''}" data-favorite="${p.id}" aria-label="${favorites.has(p.id)?'Remove from':'Add to'} saved pieces">${favorites.has(p.id)?'♥':'♡'}</button></div><div class="product-meta"><div><p class="product-name">${p.name}</p><p class="product-price">${money(p.price)}</p><p class="product-stock">${p.stock} pieces in stock</p></div><div class="product-swatch" aria-label="${p.color} color"><i class="${p.color==='black'?'dark':''}"></i></div></div>`;
    productGrid.append(card);
  }
  if(!list.length)productGrid.innerHTML=`<p class="no-results">${savedView?'NO SAVED PIECES YET. TAP ♡ TO SAVE ONE.':'NO PIECES FOUND. TRY ANOTHER SEARCH.'}</p>`;
  document.querySelector('#pieces-count').textContent=String(list.length).padStart(2,'0');
  document.querySelector('.collection-heading-label').textContent=savedView?'YOUR SAVED PIECES':'THE FIRST DROP · 2026';
  document.querySelectorAll('.filter').forEach(button=>button.classList.toggle('active',!savedView&&button.dataset.filter===activeFilter));
}
function updateHeader(){
  document.querySelector('.bag-count').textContent=totalUnits();
  document.querySelector('.wish-count').textContent=favorites.size;
  document.querySelector('.cart-total-count').textContent=`(${totalUnits()})`;
}
function showToast(message){const el=document.querySelector('#toast');el.textContent=message;el.classList.add('show');clearTimeout(toastTimer);toastTimer=setTimeout(()=>el.classList.remove('show'),2400);}
function closePanels(){pageOverlay.classList.remove('open');for(const panel of [cartDrawer,productDetailsPanel,checkoutPanel]){panel.classList.remove('open');panel.setAttribute('aria-hidden','true');}document.body.classList.remove('locked');}
function openPanel(panel){closePanels();pageOverlay.classList.add('open');panel.classList.add('open');panel.setAttribute('aria-hidden','false');document.body.classList.add('locked');}
function addToCart(product,size){
  const productUnits=cart.reduce((sum,item)=>sum+(item.id===product.id?item.qty:0),0);
  if(productUnits>=product.stock){showToast(`ONLY ${product.stock} PIECES IN STOCK`);return;}
  const existing=cart.find(item=>item.id===product.id&&item.size===size);
  if(existing){if(existing.qty>=5){showToast('MAXIMUM 5 PER SIZE');return;}existing.qty++;}else cart.push({id:product.id,size,qty:1});
  persistCart();renderCart();closePanels();showToast(`${product.name} · ${size} ADDED TO YOUR BAG`);
}
function renderCart(){
  const items=document.querySelector('#cart-items'),empty=document.querySelector('#cart-empty'),foot=document.querySelector('#cart-foot');
  items.innerHTML=cart.map((item,index)=>{const p=getProductById(item.id),otherUnits=cart.reduce((sum,current,i)=>sum+(i!==index&&current.id===item.id?current.qty:0),0),maxQuantity=Math.min(5,p.stock-otherUnits);return `<div class="cart-item"><img src="${asset(p.images[0])}" alt="${p.name}"><div><h3>${p.name}</h3><p>${money(p.price)} · ${item.size}</p><label class="quantity-label">QTY <select data-qty="${index}" aria-label="Quantity for ${p.name}">${Array.from({length:maxQuantity},(_,i)=>i+1).map(n=>`<option value="${n}" ${item.qty===n?'selected':''}>${n}</option>`).join('')}</select></label></div><button class="remove-item" data-remove="${index}">REMOVE</button></div>`;}).join('');
  empty.style.display=cart.length?'none':'flex';foot.classList.toggle('visible',!!cart.length);
  document.querySelector('#cart-subtotal').textContent=money(subtotal());
  document.querySelector('#shipping-hint').textContent='Live delivery charge calculated at checkout.';
  updateHeader();
}
function showProduct(product){
  const chartRows = TEE_SIZE_CHART.map(({ size, chest, length, shoulder, sleeve }) => `<tr><th>${size}</th><td>${chest}</td><td>${length}</td><td>${shoulder}</td><td>${sleeve}</td></tr>`).join('');
  document.querySelector('#product-detail').innerHTML=`<div class="detail-layout"><div class="detail-gallery gallery-count-${product.images.length}">${product.images.map((img,i)=>`<img src="${asset(img)}" alt="${product.name} — view ${i+1}" ${i>1?'loading="lazy"':''}>`).join('')}</div><div class="detail-info"><p class="eyebrow">M’LANG · THE FIRST DROP</p><h2>${product.name}</h2><p class="detail-price">${money(product.price)} <span>· GST AT CHECKOUT</span></p><p class="detail-description">${product.description}</p><p class="detail-description">${product.fit}</p><div class="size-label"><span>SELECT SIZE</span><button class="size-guide" aria-expanded="false" aria-controls="size-chart">SIZE GUIDE ↗</button></div><div class="sizes">${PRODUCT_SIZES.map((size,i)=>`<button class="size-option ${i===1?'selected':''}" data-size="${size}">${size}</button>`).join('')}</div><section class="size-chart" id="size-chart" hidden><h3>TEE SIZE CHART <span>CM</span></h3><div class="size-chart-scroll"><table><thead><tr><th>SIZE</th><th>CHEST CIRC.</th><th>LENGTH</th><th>SHOULDER</th><th>SLEEVE</th></tr></thead><tbody>${chartRows}</tbody></table></div><p>Measurements are approximate garment measurements. For the best fit, compare with a tee you own. Allow 1–2 cm variation.</p></section><button class="add-to-bag" data-add="${product.id}">ADD TO BAG <span>${money(product.price)} &nbsp; ↗</span></button><p class="detail-note">100% cotton · Designed in Delhi<br>Easy care · Refer to the size guide before ordering</p></div></div>`;
  openPanel(productDetailsPanel);
}
// Checkout preview, payment processing, and saved order history.
function updateShippingQuoteSummary(message='Enter your delivery PIN code for a live shipping quote.'){
  const prepaid=shippingQuotes.prepaid,cod=shippingQuotes.cod;
  const lines=document.querySelectorAll('#shipping-prepaid,#shipping-cod,#total-prepaid,#total-cod');
  if(lines.length!==4)return;
  lines[0].textContent=prepaid?money(prepaid.amount):'—';
  lines[1].textContent=cod?money(cod.amount):'—';
  lines[2].textContent=prepaid?money(subtotal()-discount()+gst()+prepaid.amount):'—';
  lines[3].textContent=cod?money(subtotal()-discount()+gst()+cod.amount):'—';
  const gstLine=document.querySelector('#gst-amount');if(gstLine)gstLine.textContent=paymentSettings.gstEnabled?money(gst()):'Not configured';
  const note=document.querySelector('#shipping-quote-status');if(note)note.textContent=message;const taxNote=checkoutPanel.querySelector('.tax-status-note');if(taxNote)taxNote.textContent=paymentSettings.gstEnabled?'5% GST is added on the discounted T-shirt value.':'GST will be calculated after the store GSTIN is configured.';
  const prepaidButton=checkoutPanel.querySelector('[data-start-payment]'),codButton=checkoutPanel.querySelector('[data-start-cod]');
  if(prepaidButton)prepaidButton.innerHTML=`${paymentSettings.mode==='live'?'PAY SECURELY WITH RAZORPAY':paymentSettings.mode==='test'?'PAY WITH RAZORPAY TEST MODE':'RAZORPAY NOT CONFIGURED'}${prepaid?` · ${money(subtotal()-discount()+gst()+prepaid.amount)}`:''} <span>↗</span>`;
  if(codButton)codButton.textContent=`PLACE COD ORDER · ${cod?money(subtotal()-discount()+gst()+cod.amount):'CALCULATING…'} · PAY ON DELIVERY`;
  updatePaymentControls();
}
async function refreshShippingQuotes(){
  const request=++shippingQuoteRequest,form=document.querySelector('#checkout-form'),pincode=form?.elements.pincode.value.trim()||'';
  shippingQuotes={prepaid:null,cod:null};
  if(!/^\d{6}$/.test(pincode)){updateShippingQuoteSummary('Enter a valid 6-digit PIN code to calculate delivery charges.');return;}
  updateShippingQuoteSummary('Calculating live courier charges…');
  const results=await Promise.all(['Prepaid','COD'].map(async paymentMethod=>{
    const response=await fetch('/api/shipping/quote',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({items:cart,coupon:appliedCoupon,pincode,paymentMethod})});
    const data=await response.json();if(!response.ok)throw new Error(data.error||'Could not calculate shipping.');return [paymentMethod,data.quote];
  }).map(promise=>promise.catch(error=>({error}))));
  if(request!==shippingQuoteRequest)return;
  const errors=[];
  for(const result of results){if(result.error){errors.push(result.error.message);continue;}const [method,quote]=result;shippingQuotes[method==='COD'?'cod':'prepaid']=quote;}
  const status=errors.length?errors[0]:`Live Shiprocket rates · cheapest eligible courier${shippingQuotes.prepaid?.estimatedDays?` · prepaid ${shippingQuotes.prepaid.estimatedDays} days`:''}${shippingQuotes.cod?.estimatedDays?` · COD ${shippingQuotes.cod.estimatedDays} days`:''}. Final carrier charges can change if parcel weight or dimensions are revised.`;
  updateShippingQuoteSummary(status);
}
function renderCheckout(){
  shippingQuotes={prepaid:null,cod:null};
  const paymentMode=paymentSettings.mode==='live'?'live':paymentSettings.mode==='test'?'test':'unconfigured',paymentLabel=paymentMode==='live'?'LIVE MODE':paymentMode==='test'?'TEST MODE':'NOT CONFIGURED',paymentButtonLabel=paymentMode==='live'?'PAY SECURELY WITH RAZORPAY':paymentMode==='test'?'PAY WITH RAZORPAY TEST MODE':'RAZORPAY NOT CONFIGURED',checkoutAvailability=paymentSettings.codEnabled?'Pay online with Razorpay or choose cash on delivery. Delivery charges are calculated from your PIN code.':'Order placement needs the store database to be connected.';
  checkoutPanel.innerHTML=`<button class="close-button checkout-close" aria-label="Close checkout">×</button><div class="checkout-inner"><div class="checkout-title"><p class="eyebrow">M’LANG · SECURE CHECKOUT</p><h2>Complete your order.</h2><p>${checkoutAvailability}</p></div><form id="checkout-form" novalidate><div class="checkout-columns"><div class="checkout-fields"><fieldset><legend>CONTACT</legend><label>Email address<input name="email" type="email" autocomplete="email" value="${escapeHtml(currentAccount?.email||'')}" ${currentAccount?'readonly':''} required></label><label>Phone number<input name="phone" type="tel" autocomplete="tel" inputmode="numeric" pattern="[0-9+ ()-]{8,16}" required></label></fieldset><fieldset><legend>DELIVERY ADDRESS</legend><label>Full name<input name="name" autocomplete="name" value="${escapeHtml(currentAccount?.name||'')}" required></label><label>Address<input name="address" autocomplete="street-address" required></label><div class="field-row"><label>City<input name="city" autocomplete="address-level2" required></label><label>State<input name="state" autocomplete="address-level1" required></label></div><div class="field-row"><label>PIN code<input name="pincode" autocomplete="postal-code" inputmode="numeric" pattern="[0-9]{6}" maxlength="6" required></label><label>Country<select name="country" required><option value="India">India</option></select></label></div></fieldset><fieldset><legend>PAYMENT</legend><div class="payment-choice"><span>RAZORPAY HOSTED CHECKOUT</span><strong>${paymentLabel}</strong></div><p class="form-note" id="razorpay-status">Checking payment configuration…</p><p class="form-note">Cash on delivery · Pay the order total to the courier when your order arrives.</p></fieldset><label class="policy-consent"><input type="checkbox" name="policyConsent" required> I have read and acknowledge the <a href="#contact" target="_blank" rel="noreferrer">Return, Refund &amp; Exchange Policy</a>.</label>${paymentMode==='test'?'<label class="test-payment-consent"><input type="checkbox" name="testPaymentConsent"> I understand this is a test payment; no real money will be charged.</label>':''}<p class="form-error" id="checkout-error" role="alert"></p><button class="place-order razorpay-button" type="button" data-start-payment disabled>${paymentButtonLabel} <span>↗</span></button><button class="cod-order-button" type="button" data-start-cod disabled>PLACE COD ORDER · CALCULATING…</button></div><aside class="order-summary"><p class="eyebrow">ORDER SUMMARY · ${totalUnits()} ITEM${totalUnits()===1?'':'S'}</p><div class="checkout-items">${cart.map(item=>{const p=getProductById(item.id);return `<div class="checkout-item"><img src="${asset(p.images[0])}" alt=""><span>${p.name} · ${item.size} × ${item.qty}</span><strong>${money(p.price*item.qty)}</strong></div>`;}).join('')}</div><div class="coupon-form" id="coupon-form"><label for="coupon">DISCOUNT CODE</label><div><input id="coupon" name="coupon" placeholder="Enter code" value="${appliedCoupon}"><button type="button" data-apply-coupon>APPLY</button></div><small id="coupon-message">${appliedCoupon?'WELCOME10 applied':'Try WELCOME10 for 10% off.'}</small></div><div class="summary-lines"><p><span>Subtotal</span><span>${money(subtotal())}</span></p><p><span>Discount</span><span>− ${money(discount())}</span></p><p><span>GST · 5%</span><span id="gst-amount">${paymentSettings.gstEnabled?money(gst()):'Not configured'}</span></p><p><span>Shipping · prepaid</span><span id="shipping-prepaid">—</span></p><p><span>Shipping · COD</span><span id="shipping-cod">—</span></p><p><span>Total · prepaid</span><strong id="total-prepaid">—</strong></p><p class="summary-total"><span>Total · COD</span><strong id="total-cod">—</strong></p></div><p class="form-note tax-status-note">${paymentSettings.gstEnabled?'5% GST is added on the discounted T-shirt value.':'GST will be calculated after the store GSTIN is configured.'}</p><p class="form-note" id="shipping-quote-status">Enter your delivery PIN code for a live shipping quote.</p><p class="form-note">Shiprocket calculates an estimate using pickup/delivery PINs and parcel dimensions/weight. Final carrier charges may change after parcel measurement.</p></aside></div></form></div>`;
  openPanel(checkoutPanel);updatePaymentControls();
  checkoutPanel.querySelector('[name="pincode"]').addEventListener('input',()=>{clearTimeout(window.mlangShippingDebounce);window.mlangShippingDebounce=setTimeout(refreshShippingQuotes,500);});
}
function showOrderConfirmation(order){
  const shippingMessage=order.shipping?.status==='booked'?`Shiprocket shipment booked · AWB ${order.shipping.awb}.`:order.shipping?.status==='pending_setup'?'Shiprocket booking is pending API credentials, pickup location, and parcel dimensions in .env.':'Shiprocket could not book this shipment yet; check the admin order record for the carrier response.';
  const emailMessage=order.emailStatus==='sent'?'Order confirmation email sent.':order.emailStatus==='pending_setup'?'Email receipt is pending mail provider setup in .env.':'Email receipt could not be sent; you can see this order in your account.';
  checkoutPanel.innerHTML=`<div class="order-confirmation"><p class="eyebrow">${order.paymentMethod==='COD'?'COD ORDER RECEIVED':order.paid?`RAZORPAY ${String(order.mode||paymentSettings.mode||'test').toUpperCase()} PAYMENT VERIFIED`:'ORDER RECEIVED'}</p><div class="confirmation-mark">✓</div><h2>Thanks, ${escapeHtml(order.name.split(' ')[0])}.</h2><p>Your order number is <strong>${escapeHtml(order.number)}</strong>.</p><p class="confirmation-note">${order.paymentMethod==='COD'?`Pay ${money(order.total)} to the courier on delivery. ${escapeHtml(shippingMessage)} ${emailMessage}`:order.paid?`Your payment was verified. ${escapeHtml(shippingMessage)} ${emailMessage}`:'Your order has been confirmed.'}</p><div class="confirmation-receipt"><span>${order.items} item${order.items===1?'':'s'} · GST ${money(order.gst||0)}</span><strong>${money(order.total)}</strong></div><button class="place-order" id="continue-shopping">CONTINUE SHOPPING <span>↗</span></button></div>`;
  checkoutPanel.querySelector('#continue-shopping').addEventListener('click',()=>{closePanels();window.location.hash='products';});
}
function updatePaymentControls(){
  const button=checkoutPanel.querySelector('[data-start-payment]'),status=checkoutPanel.querySelector('#razorpay-status');
  if(!button||!status)return;
  button.disabled=!paymentSettings.razorpayEnabled||isPaymentInProgress||!shippingQuotes.prepaid?.token;
  const codButton=checkoutPanel.querySelector('[data-start-cod]');if(codButton)codButton.disabled=!paymentSettings.codEnabled||isPaymentInProgress||!shippingQuotes.cod?.token;
  const storageMessage=paymentSettings.databaseEnabled?'Supabase order storage is connected.':paymentSettings.codEnabled?'Supabase is not connected; orders stay on this computer.':'Connect Supabase before accepting orders on this deployment.';
  const accountMessage=paymentSettings.razorpayEnabled?`Razorpay ${String(paymentSettings.mode||'test').toUpperCase()} Mode is ready. No account is required. ${paymentSettings.shiprocketEnabled?'Shiprocket booking runs after payment.':'Shipping booking needs Shiprocket API credentials, the configured pickup name, and parcel dimensions.'} ${paymentSettings.emailEnabled?'M’LANG order emails are enabled.':'M’LANG order emails need a Resend API key and verified sender.'}`:'Razorpay is not configured. Add the matching Key ID and Key Secret to the deployment environment.';
  status.textContent=`${accountMessage} ${storageMessage}`;
}
async function loadPaymentConfig(){
  try{const [configResponse,accountResponse]=await Promise.all([fetch('/api/config'),fetch('/api/auth/me')]);if(configResponse.ok)paymentSettings=await configResponse.json();if(accountResponse.ok)currentAccount=(await accountResponse.json()).user;updateAccountButton();updatePaymentControls();updateShippingQuoteSummary(paymentSettings.gstEnabled?'Enter your delivery PIN code for a live shipping quote.':'GST will be calculated after the store GSTIN is configured.');}
  catch{updatePaymentControls();}
}
function updateAccountButton(){const button=document.querySelector('.account-toggle');button.textContent=currentAccount?(currentAccount.role==='admin'?'ADMIN · ':'ACCOUNT · ')+currentAccount.name.split(' ')[0].toUpperCase():'ACCOUNT';button.setAttribute('aria-label',currentAccount?`${currentAccount.role==='admin'?'Admin':'Account'} for ${currentAccount.name}`:'Sign in or create account');}
function accountForm(mode){accountEmail=mode==='verify'?accountEmail:'';const title=mode==='register'?'Create your account':mode==='verify'?'Check your email':'Welcome back';const fields=mode==='register'?'<label>Full name<input name="name" autocomplete="name" required minlength="2"></label><label>Email address<input name="email" type="email" autocomplete="email" required></label><label>Password<input name="password" type="password" autocomplete="new-password" required minlength="10" maxlength="128"></label>':mode==='verify'?`<p class="form-note">We sent a 6-digit code to ${escapeHtml(accountEmail)}. It expires in 10 minutes.</p><input type="hidden" name="email" value="${escapeHtml(accountEmail)}"><label>Verification code<input name="code" inputmode="numeric" pattern="[0-9]{6}" maxlength="6" autocomplete="one-time-code" required></label>`:'<label>Email address<input name="email" type="email" autocomplete="email" required></label><label>Password<input name="password" type="password" autocomplete="current-password" required maxlength="128"></label>';checkoutPanel.innerHTML=`<button class="close-button checkout-close" aria-label="Close account">×</button><div class="account-panel"><p class="eyebrow">M’LANG · CUSTOMER ACCOUNT</p><h2>${title}</h2><form id="account-form" data-mode="${mode}" novalidate>${fields}<p class="form-error" id="account-error" role="alert"></p><button class="place-order" type="submit">${mode==='verify'?'VERIFY EMAIL':'CONTINUE'} <span>↗</span></button></form><p class="form-note account-switch">${mode==='login'?(paymentSettings.emailEnabled?`New here? <button type="button" data-account-mode="register">CREATE ACCOUNT</button>`:'Account registration is unavailable right now. You can check out without an account.'):mode==='register'?`Already have an account? <button type="button" data-account-mode="login">SIGN IN</button>`:''}</p></div>`;openPanel(checkoutPanel);}
async function openAccount(){if(currentAccount){await renderAccountOrders();return;}accountForm('login');}
async function renderAccountOrders(){if(currentAccount.role==='admin'){await renderAdminOrders();return;}checkoutPanel.innerHTML='<button class="close-button checkout-close" aria-label="Close account">×</button><div class="account-panel"><p class="eyebrow">M’LANG · CUSTOMER ACCOUNT</p><h2>Hi, <span class="account-name"></span>.</h2><p class="form-note account-email"></p><div class="account-orders-list"><p class="form-note">Loading your orders…</p></div><button class="account-secondary-action" type="button" data-account-logout>SIGN OUT</button></div>';checkoutPanel.querySelector('.account-name').textContent=currentAccount.name.split(' ')[0];checkoutPanel.querySelector('.account-email').textContent=currentAccount.email;openPanel(checkoutPanel);const list=checkoutPanel.querySelector('.account-orders-list');try{const response=await fetch('/api/account/orders'),data=await response.json();if(!response.ok)throw new Error(data.error||'Could not load orders.');list.innerHTML='';if(!data.orders.length){const empty=document.createElement('p');empty.className='form-note';empty.textContent='No orders yet.';list.append(empty);}for(const order of data.orders){const row=document.createElement('article');row.className='account-order';const title=document.createElement('strong');title.textContent=order.id;const details=document.createElement('p');details.textContent=`${order.itemCount} item${order.itemCount===1?'':'s'} · ${money(order.total)} · ${new Date(order.createdAt).toLocaleDateString('en-IN')}`;const shipment=document.createElement('p');shipment.textContent=order.shipping.awb?`Shiprocket AWB ${order.shipping.awb}`:`Shipment: ${order.shipping.status}`;row.append(title,details,shipment);if(order.shipping.awb){const track=document.createElement('button');track.type='button';track.className='tracking-button';track.textContent='TRACK SHIPMENT';track.dataset.trackOrder=order.id;const timeline=document.createElement('div');timeline.className='tracking-timeline';row.append(track,timeline);}list.append(row);}}catch(error){list.textContent=error.message;}}
async function renderAdminOrders(){checkoutPanel.innerHTML='<button class="close-button checkout-close" aria-label="Close admin panel">×</button><div class="account-panel admin-panel"><p class="eyebrow">THE MALANG COMPANY · ADMIN</p><h2>All orders.</h2><p class="form-note">Signed in as <span class="admin-email"></span></p><button class="tracking-button" type="button" data-refresh-admin>REFRESH ORDERS</button><div class="admin-orders-list"><p class="form-note">Loading orders…</p></div><button class="account-secondary-action" type="button" data-account-logout>SIGN OUT</button></div>';checkoutPanel.querySelector('.admin-email').textContent=currentAccount.email;openPanel(checkoutPanel);const list=checkoutPanel.querySelector('.admin-orders-list');try{const response=await fetch('/api/admin/orders'),data=await response.json();if(!response.ok)throw new Error(data.error||'Could not load store orders.');list.innerHTML='';if(!data.orders.length){const empty=document.createElement('p');empty.className='form-note';empty.textContent='No orders yet.';list.append(empty);}for(const order of data.orders){const row=document.createElement('article');row.className='admin-order';const title=document.createElement('strong');title.textContent=`${order.id} · ${money(order.total)} · ${order.status}`;const date=document.createElement('p');date.textContent=new Date(order.createdAt).toLocaleString('en-IN');const customer=document.createElement('p');customer.textContent=`${order.customer.name||'Customer'} · ${order.customer.email||''} · ${order.customer.phone||''}`;const address=document.createElement('p');address.textContent=[order.customer.address,order.customer.city,order.customer.state,order.customer.pincode].filter(Boolean).join(', ');const products=document.createElement('p');products.textContent=order.items.map(item=>`${item.name} · ${item.size} × ${item.qty} (${money(item.lineTotal||item.unitPrice*item.qty)})`).join(' | ');const payment=document.createElement('p');payment.textContent=`Payment: ${order.paymentMethod||'Prepaid'} · GST 5%: ${money(order.gst||0)}`;const shipping=document.createElement('p');shipping.textContent=`Shiprocket: ${order.shipping.status}${order.shipping.awb?` · AWB ${order.shipping.awb}`:''}${Number.isFinite(order.shipping.charge)?` · customer shipping ${money(order.shipping.charge)}`:''}${order.shipping.courier?` · ${order.shipping.courier}`:''}`;const mail=document.createElement('p');mail.textContent=`Receipt email: ${order.emailStatus}`;row.append(title,date,customer,address,products,payment,shipping,mail);if(order.shipping.status==='booking_failed'&&!order.shipping.awb){const retry=document.createElement('button');retry.type='button';retry.className='tracking-button';retry.textContent='RETRY SHIPROCKET BOOKING';retry.dataset.retryShipment=order.id;row.append(retry);}list.append(row);}}catch(error){list.textContent=error.message;}}
async function retryShiprocketBooking(button){if(!window.confirm('Retry this real Shiprocket shipment booking? This can create a courier shipment and may incur shipping charges.'))return;button.disabled=true;button.textContent='RETRYING…';try{const response=await fetch(`/api/admin/orders/${encodeURIComponent(button.dataset.retryShipment)}/retry-shipment`,{method:'POST'}),data=await response.json();if(!response.ok)throw new Error(data.error||data.order?.shipping?.message||'Shiprocket retry failed.');showToast(data.order?.shipping?.awb?'SHIPROCKET BOOKED · AWB '+data.order.shipping.awb:'SHIPROCKET RETRY COMPLETE');await renderAdminOrders();}catch(error){showToast(error.message||'SHIPROCKET RETRY FAILED');button.disabled=false;button.textContent='RETRY SHIPROCKET BOOKING';}}
async function trackAccountOrder(button){button.disabled=true;const timeline=button.parentElement.querySelector('.tracking-timeline');timeline.textContent='Loading Shiprocket updates…';try{const response=await fetch(`/api/account/orders/${encodeURIComponent(button.dataset.trackOrder)}/tracking`),data=await response.json();if(!response.ok)throw new Error(data.error||'Tracking is unavailable.');timeline.innerHTML='';const status=document.createElement('strong');status.textContent=data.status||'Tracking update';timeline.append(status);for(const event of data.timeline||[]){const item=document.createElement('p');item.textContent=[event.time,event.location,event.status].filter(Boolean).join(' · ');timeline.append(item);}if(!data.timeline?.length){const note=document.createElement('p');note.textContent=data.message||'No carrier scan has been posted yet.';timeline.append(note);}}catch(error){timeline.textContent=error.message;}finally{button.disabled=false;}}
function loadRazorpaySdk(){
  if(window.Razorpay)return Promise.resolve();
  return new Promise((resolve,reject)=>{const script=document.createElement('script');script.src='https://checkout.razorpay.com/v1/checkout.js';script.onload=resolve;script.onerror=()=>reject(new Error('Could not load Razorpay Checkout. Check your internet connection and retry.'));document.head.append(script);});
}
async function startRazorpayPayment(){
  const form=document.querySelector('#checkout-form'),error=document.querySelector('#checkout-error');
  if(!form||!form.reportValidity())return;
  if(paymentSettings.mode==='test'&&!form.querySelector('[name=testPaymentConsent]')?.checked){document.querySelector('#checkout-error').textContent='Confirm that this is a Razorpay test payment.';return;}
  if(!paymentSettings.razorpayEnabled){error.textContent='Razorpay is not configured for this environment. Check the live Razorpay Key ID and Key Secret in Vercel environment variables.';return;}
  isPaymentInProgress=true;updatePaymentControls();error.textContent='';
  try{
    const values=new FormData(form),customer={name:values.get('name'),email:values.get('email'),phone:values.get('phone'),address:values.get('address'),city:values.get('city'),state:values.get('state'),pincode:values.get('pincode')};
    const orderResponse=await fetch('/api/razorpay/orders',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({items:cart,coupon:appliedCoupon,customer,shippingQuote:shippingQuotes.prepaid?.token,policyAccepted:values.get('policyConsent')==='on'})});
    const order=await orderResponse.json();if(!orderResponse.ok)throw new Error(order.error||'Could not prepare your Razorpay order.');
    await loadRazorpaySdk();
    const checkout=new window.Razorpay({key:order.keyId,amount:order.amount,currency:order.currency,name:'M’LANG',description:'M’LANG streetwear order',order_id:order.orderId,prefill:{name:customer.name,email:customer.email,contact:customer.phone},theme:{color:'#171716'},modal:{ondismiss:()=>{isPaymentInProgress=false;updatePaymentControls();}},handler:async response=>{
      try{
        const verified=await fetch('/api/razorpay/verify',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({...response,customer})});
        const result=await verified.json();if(!verified.ok)throw new Error(result.error||'Payment verification failed.');
        const receipt={number:result.order.id,items:result.order.itemCount,total:result.order.total,gst:result.order.gst,createdAt:new Date().toISOString(),paid:true,mode:order.mode,paymentMethod:'RAZORPAY',shipping:result.order.shipping,emailStatus:result.order.emailStatus};
        cart=[];persistCart();appliedCoupon='';isPaymentInProgress=false;renderCart();showOrderConfirmation({...receipt,name:customer.name,paid:true});
      }catch(failure){isPaymentInProgress=false;error.textContent=failure.message;updatePaymentControls();}
    }});
    checkout.on('payment.failed',response=>{error.textContent=response?.error?.description||'Payment failed. Please retry or use another payment method.';isPaymentInProgress=false;updatePaymentControls();});
    checkout.open();
  }catch(failure){error.textContent=failure.message;isPaymentInProgress=false;updatePaymentControls();}
}
async function startCodOrder(){
  const form=document.querySelector('#checkout-form'),error=document.querySelector('#checkout-error'),button=checkoutPanel.querySelector('[data-start-cod]');
  if(!form||!form.reportValidity())return;
  if(!cart.length){error.textContent='Your bag is empty.';return;}
  isPaymentInProgress=true;button.disabled=true;error.textContent='';
  try{
    const values=new FormData(form),customer={name:values.get('name'),email:values.get('email'),phone:values.get('phone'),address:values.get('address'),city:values.get('city'),state:values.get('state'),pincode:values.get('pincode')};
    const response=await fetch('/api/orders/cod',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({items:cart,coupon:appliedCoupon,customer,shippingQuote:shippingQuotes.cod?.token,policyAccepted:values.get('policyConsent')==='on'})});
    const result=await response.json();if(!response.ok)throw new Error(result.error||'Could not place your COD order.');
    const receipt=result.order;cart=[];persistCart();appliedCoupon='';isPaymentInProgress=false;renderCart();showOrderConfirmation({number:receipt.id,items:receipt.itemCount,total:receipt.total,name:customer.name,paymentMethod:'COD',gst:receipt.gst,shipping:receipt.shipping,emailStatus:receipt.emailStatus});
  }catch(failure){error.textContent=failure.message;isPaymentInProgress=false;button.disabled=false;}
}
function showOrderHistory(){openAccount();}
function openSearch(){
  let panel=document.querySelector('.search-panel');
  if(!panel){panel=document.createElement('div');panel.className='search-panel';panel.innerHTML='<input class="search-input" type="search" placeholder="Find your piece…" aria-label="Search products"><button class="search-close" aria-label="Close search">×</button>';document.querySelector('.site-header').after(panel);panel.querySelector('input').addEventListener('input',event=>{searchQuery=event.target.value.trim();savedView=false;renderProducts();document.querySelector('#products').scrollIntoView({behavior:'smooth'});});panel.querySelector('button').addEventListener('click',()=>{panel.classList.remove('open');panel.querySelector('input').value='';searchQuery='';renderProducts();});}
  panel.classList.toggle('open');if(panel.classList.contains('open'))panel.querySelector('input').focus();
}

// Page event handlers and initial UI render.
document.querySelector('.collection .eyebrow').classList.add('collection-heading-label');
document.querySelector('.filters').addEventListener('click',event=>{const button=event.target.closest('.filter');if(!button)return;savedView=false;activeFilter=button.dataset.filter;renderProducts();});
document.querySelector('#sort-products').addEventListener('change',event=>{sortMode=event.target.value;renderProducts();});
productGrid.addEventListener('click',event=>{
  const fav=event.target.closest('[data-favorite]');
  if(fav){const id=fav.dataset.favorite;if(favorites.has(id))favorites.delete(id);else favorites.add(id);writeStore('mlang-favorites',[...favorites]);updateHeader();renderProducts();return;}
  const quick=event.target.closest('[data-quick]');if(quick){showProduct(getProductById(quick.dataset.quick));return;}
  const card=event.target.closest('.product-card');if(card)showProduct(getProductById(card.dataset.id));
});
document.querySelector('.wishlist-toggle').addEventListener('click',()=>{savedView=!savedView;activeFilter='all';searchQuery='';renderProducts();document.querySelector('#products').scrollIntoView({behavior:'smooth'});});
document.querySelector('.bag-toggle').addEventListener('click',()=>{renderCart();openPanel(cartDrawer);});
document.querySelector('#cart-drawer .close-button').addEventListener('click',closePanels);
document.querySelector('.modal-close').addEventListener('click',closePanels);
pageOverlay.addEventListener('click',closePanels);
document.addEventListener('keydown',event=>{if(event.key==='Escape')closePanels();});
document.querySelector('#product-detail').addEventListener('click',event=>{
  const size=event.target.closest('[data-size]');if(size){document.querySelectorAll('.size-option').forEach(el=>el.classList.toggle('selected',el===size));return;}
  const guide=event.target.closest('.size-guide');if(guide){const chart=document.querySelector('#size-chart'),open=chart.hidden;chart.hidden=!open;guide.setAttribute('aria-expanded',String(open));guide.textContent=open?'CLOSE SIZE GUIDE ×':'SIZE GUIDE ↗';return;}
  const add=event.target.closest('[data-add]');if(add)addToCart(getProductById(add.dataset.add),document.querySelector('.size-option.selected')?.dataset.size||'M');
});
document.querySelector('#cart-items').addEventListener('click',event=>{const remove=event.target.closest('[data-remove]');if(remove){cart.splice(Number(remove.dataset.remove),1);persistCart();renderCart();}});
document.querySelector('#cart-items').addEventListener('change',event=>{const select=event.target.closest('[data-qty]');if(select){cart[Number(select.dataset.qty)].qty=Number(select.value);persistCart();renderCart();}});
document.querySelector('.checkout-button').addEventListener('click',()=>{if(!cart.length)return;appliedCoupon='';renderCheckout();});
checkoutPanel.addEventListener('click',event=>{if(event.target.closest('.checkout-close'))closePanels();});
checkoutPanel.addEventListener('click',event=>{
  if(event.target.closest('[data-start-payment]')){startRazorpayPayment();return;}
  if(event.target.closest('[data-start-cod]')){startCodOrder();return;}
  if(event.target.closest('[data-refresh-admin]')){renderAdminOrders();return;}
  const retryShipment=event.target.closest('[data-retry-shipment]');if(retryShipment){retryShiprocketBooking(retryShipment);return;}
  const accountMode=event.target.closest('[data-account-mode]');if(accountMode){accountForm(accountMode.dataset.accountMode);return;}
  const track=event.target.closest('[data-track-order]');if(track){trackAccountOrder(track);return;}
  if(event.target.closest('[data-account-logout]')){fetch('/api/auth/logout',{method:'POST'}).catch(()=>{}).finally(()=>{currentAccount=null;updateAccountButton();updatePaymentControls();accountForm('login');});return;}
  if(event.target.closest('[data-apply-coupon]')){const code=document.querySelector('#coupon').value.trim().toUpperCase();if(code==='WELCOME10'){appliedCoupon=code;document.querySelector('#coupon-message').textContent='WELCOME10 applied';document.querySelector('.summary-lines p:nth-child(2) span:last-child').textContent=`− ${money(discount())}`;refreshShippingQuotes();showToast('WELCOME10 APPLIED');}else{document.querySelector('#coupon-message').textContent='That discount code is not valid.';}}
});
checkoutPanel.addEventListener('submit',async event=>{
  const form=event.target;if(form.id!=='account-form')return;event.preventDefault();const error=form.querySelector('#account-error');if(!form.reportValidity())return;error.textContent='';const data=new FormData(form),mode=form.dataset.mode;let endpoint,payload;
  if(mode==='register'){endpoint='/api/auth/register';payload={name:data.get('name'),email:data.get('email'),password:data.get('password')};}
  else if(mode==='verify'){endpoint='/api/auth/verify';payload={email:data.get('email'),code:data.get('code')};}
  else{endpoint='/api/auth/login';payload={email:data.get('email'),password:data.get('password')};}
  const submit=form.querySelector('button[type="submit"]');submit.disabled=true;
  try{const response=await fetch(endpoint,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)}),result=await response.json();if(!response.ok)throw new Error(result.error||'Account request failed.');if(mode==='register'){accountEmail=result.email;accountForm('verify');return;}currentAccount=result.user;updateAccountButton();updatePaymentControls();await renderAccountOrders();}
  catch(failure){error.textContent=failure.message;}finally{submit.disabled=false;}
});
checkoutPanel.addEventListener('submit',event=>{
  if(event.target.id!=='checkout-form')return;event.preventDefault();
  if(!event.target.reportValidity())return;
  startRazorpayPayment();
});
document.querySelector('.search-toggle').addEventListener('click',openSearch);
document.querySelector('.account-toggle').addEventListener('click',openAccount);
document.querySelector('.orders-toggle').addEventListener('click',event=>{event.preventDefault();showOrderHistory();});
document.querySelector('.menu-toggle').addEventListener('click',()=>document.querySelector('.main-nav').classList.toggle('open'));
document.querySelectorAll('.main-nav a').forEach(link=>link.addEventListener('click',()=>document.querySelector('.main-nav').classList.remove('open')));
document.querySelector('#newsletter-form').addEventListener('submit',event=>{event.preventDefault();document.querySelector('#newsletter-status').textContent='PREVIEW ONLY — NEWSLETTER SIGNUPS ARE NOT CONNECTED YET.';event.target.reset();});
document.querySelector('.empty-cart-link').addEventListener('click',closePanels);
document.querySelector('.collection-heading-label').textContent='THE FIRST DROP · 2026';
renderCart();renderProducts();
loadPaymentConfig();
