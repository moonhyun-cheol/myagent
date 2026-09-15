#!/usr/bin/env node
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from 'playwright';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const workspace = path.join(root, 'ui/workspace');
const { createServer } = await import(pathToFileURL(path.join(workspace, 'node_modules/vite/dist/node/index.js')).href);
const html = `<!doctype html><html><body><div id="root"></div><script type="module">
import React,{useRef,useState} from 'react';
import {createRoot} from 'react-dom/client';
import {ContextMenuPortal} from '/src/components/ContextMenu.tsx';
import {useAnchoredOverlay} from '/src/lib/useAnchoredOverlay.ts';
import '/src/index.css';
function Fixture(){
 const [menu,setMenu]=useState(null),[open,setOpen]=useState(false);const anchor=useRef(null),overlay=useRef(null);
 useAnchoredOverlay({open,anchorRef:anchor,overlayRef:overlay,align:'end'});
 return React.createElement(React.Fragment,null,
  React.createElement('button',{id:'point',style:{position:'fixed',right:2,bottom:2},onContextMenu:e=>{e.preventDefault();setMenu({x:e.clientX,y:e.clientY,items:[{id:'nested',label:'nested',children:[{id:'child',label:'child'}]}]});}},'point'),
  React.createElement('button',{id:'anchor',ref:anchor,style:{position:'fixed',right:2,top:20},onClick:()=>setOpen(v=>!v)},'anchor'),
  open?React.createElement('div',{id:'anchored',ref:overlay,style:{position:'fixed',visibility:'hidden',width:180,height:90}},'anchored'):null,
  React.createElement(ContextMenuPortal,{menu,onClose:()=>setMenu(null)})
 );
}
createRoot(document.getElementById('root')).render(React.createElement(Fixture));
</script></body></html>`;
const server = await createServer({root:workspace,server:{host:'127.0.0.1',port:0,strictPort:false},plugins:[{name:'overlay-test',configureServer(vite){vite.middlewares.use('/__overlay_test',async(req,res,next)=>{if(req.url?.includes('html-proxy'))return next();try{res.setHeader('Content-Type','text/html');res.end(await vite.transformIndexHtml('/__overlay_test',html));}catch(error){next(error);}});}}]});
const executablePath=[process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe','C:/Program Files/Microsoft/Edge/Application/msedge.exe'].find(p=>p&&existsSync(p));
let browser;
try{
 await server.listen();browser=await chromium.launch({headless:true,...(executablePath?{executablePath}:{})});
 const page=await browser.newPage({viewport:{width:700,height:240}});const errors=[];page.on('pageerror',e=>errors.push(e.message));
 const address=server.httpServer.address();await page.goto(`http://127.0.0.1:${address.port}/__overlay_test`);
 await page.locator('#point').click({button:'right'});const menu=page.getByRole('menu').first();await menu.waitFor();
 let box=await menu.boundingBox();assert.ok(box.x>=8&&box.y>=8&&box.x+box.width<=692&&box.y+box.height<=232,'pointer menu stays in viewport');
 await menu.getByRole('menuitem',{name:'nested'}).hover();const submenu=page.getByRole('menu').nth(1);await submenu.waitFor();box=await submenu.boundingBox();assert.ok(box.x>=0&&box.x+box.width<=700,`submenu flips inside viewport: ${JSON.stringify(box)}`);
 await page.keyboard.press('Escape');await page.locator('#anchor').click();await page.locator('#anchored').waitFor({state:'visible'});
 await page.setViewportSize({width:300,height:220});await page.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))));
 const anchorBox=await page.locator('#anchor').boundingBox(), anchoredBox=await page.locator('#anchored').boundingBox();
 assert.ok(anchoredBox.x>=8&&anchoredBox.x+anchoredBox.width<=292,'anchored menu stays in resized viewport');
 const expectedRight=Math.min(anchorBox.x+anchorBox.width,292);
 assert.ok(Math.abs(expectedRight-(anchoredBox.x+anchoredBox.width))<=1,'anchored menu follows trigger or viewport padding');
 assert.deepEqual(errors,[]);console.log(JSON.stringify({ok:true,checks:['point clamp','submenu flip','anchor remeasure after resize']}));
}finally{await browser?.close();await server.close();}
