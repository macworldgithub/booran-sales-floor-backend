const { randomBytes } = require('node:crypto');
const escapeHtml = (value) => String(value).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
function mediaViewer(media) {
  const nonce = randomBytes(24).toString('base64');
  const url = `/api/media/${media.share_token}/content`;
  const video = media.content_type.startsWith('video/');
  const branding = media.branding;
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Shared ${video ? 'video' : 'photo'} | Booran Motors</title><style>body{margin:0;background:#f1f5f9;color:#0f172a;font:16px system-ui,sans-serif}main{max-width:900px;margin:36px auto;padding:24px;background:white;border-radius:20px;box-shadow:0 10px 35px #0f172a12}header{font-weight:800;font-size:20px;border-bottom:3px solid #dc2626;padding-bottom:16px}h1{font-size:22px;overflow-wrap:anywhere}img,video{display:block;max-width:100%;max-height:70vh;margin:20px auto;border-radius:12px}button{background:#dc2626;color:white;border:0;border-radius:10px;padding:12px 18px;cursor:pointer}button:disabled{opacity:.5}p{color:#64748b;font-size:14px}@media(max-width:600px){main{margin:0;border-radius:0;padding:18px}}</style></head><body><main><header>${escapeHtml(branding?.name || 'BOORAN MOTORS')}</header><p>A ${video ? 'video' : 'photo'} shared with you by Booran Sales Floor</p><h1>${escapeHtml(media.name)}</h1>${video ? `<video controls playsinline preload="metadata" src="${url}"></video>` : '<img id="photo" alt="Shared photo">'}<p id="status" role="status">${video ? 'Press play to watch the video.' : 'Loading photo…'}</p><button id="download">Download ${video ? 'video' : 'photo'}</button>${video ? '<button id="review">Mark as reviewed</button>' : ''}${branding ? `<p>${escapeHtml(branding.phone)} · ${escapeHtml(branding.email)}</p>` : ''}</main><script nonce="${nonce}">
const total=${media.size},url=${JSON.stringify(url)},type=${JSON.stringify(media.content_type)},name=${JSON.stringify(media.name).replace(/</g, '\\u003c')};
const status=document.getElementById('status'),button=document.getElementById('download');let file;
async function load(){if(file)return file;const chunks=[];for(let start=0;start<total;start+=2097152){const end=Math.min(total-1,start+2097151);const response=await fetch(url,{headers:{Range:'bytes='+start+'-'+end},cache:'no-store'});if(!response.ok)throw new Error('The file could not be loaded. Please try again.');const bytes=await response.arrayBuffer();if(bytes.byteLength!==end-start+1)throw new Error('The file download was interrupted. Please try again.');chunks.push(bytes);status.textContent='Loading '+Math.round((end+1)/total*100)+'%';}file=URL.createObjectURL(new Blob(chunks,{type}));status.textContent='';return file;}
button.addEventListener('click',async()=>{button.disabled=true;try{const a=document.createElement('a');a.href=await load();a.download=name;document.body.appendChild(a);a.click();a.remove();}catch(error){status.textContent=error.message;}finally{button.disabled=false;}});
${video ? `
const eventUrl=${JSON.stringify(`/api/media/${media.share_token}/events`)};
let session;try{session=sessionStorage.getItem('video-session');if(!session){session=crypto.randomUUID();sessionStorage.setItem('video-session',session);}}catch{session=crypto.randomUUID();}
async function track(event){const response=await fetch(eventUrl,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({event,session}),keepalive:true});if(!response.ok)throw new Error('Could not save review. Please retry.');}
let viewed=false;document.querySelector('video').addEventListener('play',()=>{if(!viewed){viewed=true;track('view').catch(()=>{viewed=false;});}});
document.getElementById('review').addEventListener('click',async event=>{const button=event.currentTarget;button.disabled=true;try{await track('review');button.textContent='Reviewed — thank you';}catch(error){button.disabled=false;status.textContent=error.message;}});
` : "load().then(src=>{document.getElementById('photo').src=src;}).catch(error=>{status.textContent=error.message;});"}
</script></body></html>`;
  return { html, policy: `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; img-src blob:; media-src 'self' blob:; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'` };
}
module.exports = { mediaViewer };
