'use strict';

// Run against the real Electron renderer, with a hidden window and a fresh diary.
const { app, BrowserWindow, protocol } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { pathToFileURL } = require('node:url');
const root = path.resolve(__dirname, '..');
let testDirectory, backend, window;
app.disableHardwareAcceleration();
protocol.registerSchemesAsPrivileged([{scheme:'stillwater',privileges:{standard:true,secure:true,supportFetchAPI:true}}]);
const errors = [];

(async()=>{
  testDirectory = await fs.mkdtemp(path.join(os.tmpdir(),'stillwater-math-renderer-'));
  app.setPath('userData',path.join(testDirectory,'profile'));
  process.env.STILLWATER_DESKTOP = '1';
  process.env.DIARY_DATA_DIR = path.join(testDirectory,'diary');
  await app.whenReady();
  backend = await import(pathToFileURL(path.join(root,'server.mjs')).href);
  protocol.handle('stillwater',request=>backend.handleDesktopRequest(request));
  window = new BrowserWindow({show:false,width:1400,height:1020,webPreferences:{contextIsolation:true,nodeIntegration:false,sandbox:true,offscreen:true,backgroundThrottling:false}});
  window.webContents.on('console-message',event=>{if(event.level==='error')errors.push(event.message);});
  await window.loadURL('stillwater://app/');
  const results = await window.webContents.executeJavaScript(`(async()=>{
    const results=[];
    function assert(condition,message){if(!condition)throw new Error(message);results.push(message);}
    const until=Date.now()+10000;while(!initialized&&Date.now()<until)await new Promise(resolve=>setTimeout(resolve,20));
    assert(initialized,'App initialized with an isolated diary');
    await newEntry();
    const entryId=current().id;
    function content(value,start,end=start){
      const ed=$('#editor');ed.innerHTML='<p></p>';ed.firstChild.textContent=value;editorChanged();ed.focus();
      const range=document.createRange();range.setStart(ed.firstChild.firstChild,start);range.setEnd(ed.firstChild.firstChild,end);
      const selection=getSelection();selection.removeAllRanges();selection.addRange(range);selectionRange=range.cloneRange();
    }
    const settle=()=>new Promise(resolve=>setTimeout(resolve,0));
    async function open(typeset=false){ $('[data-action="insert-math"]').click();await settle();assert($('#modal').open,'Insert math opens from the toolbar');if(!typeset){$('#math-typeset').checked=false;$('#math-expression').value='';$('#math-expression').dispatchEvent(new Event('input',{bubbles:true}));} }
    function symbol(value){return [...document.querySelectorAll('#math-symbol-grid [data-math-value]')].find(button=>button.dataset.mathValue===value);}
    content('Before AFTER',7,12);
    await open();
    assert($('[data-modal-value="insert"]').disabled,'Empty expression cannot be inserted');
    $('#math-search').value='pi';$('#math-search').dispatchEvent(new Event('input',{bubbles:true}));
    assert(!!symbol('π'),'Symbol search finds pi by name');
    symbol('π').click();$('[data-modal-value="insert"]').click();await settle();
    assert($('#editor').textContent==='Before π','Rich insertion replaces the original selection');
    document.execCommand('undo');editorChanged();
    assert($('#editor').textContent==='Before AFTER','Rich insertion can be undone');
    document.execCommand('redo');editorChanged();
    assert($('#editor').textContent==='Before π','Rich insertion can be redone');

    content('Left right',4);
    await open();
    $('#math-category').value='3';$('#math-category').dispatchEvent(new Event('change',{bubbles:true}));
    assert(!!symbol('ℝ')&&!symbol('π'),'Categories filter the symbol grid');
    $('#math-search').value='no-such-symbol';$('#math-search').dispatchEvent(new Event('input',{bubbles:true}));
    assert(!!$('.math-no-results'),'Empty search has a helpful result');
    $('#math-expression').value='π + √(x)';$('#math-expression').dispatchEvent(new Event('input',{bubbles:true}));
    $('[data-modal-value="insert"]').click();await settle();
    assert($('#editor').textContent==='Leftπ + √(x) right','Expression insertion restores the original caret');
    await flush();await reload();renderEditor(current());
    assert($('#editor').textContent==='Leftπ + √(x) right','Symbols survive saving and rendering again');
    await open();$('#modal').dispatchEvent(new Event('cancel',{cancelable:true}));await settle();
    assert(!$('#modal').open&&$('#editor').textContent==='Leftπ + √(x) right','Escape cancels without changing the entry');

    content('x2',1,2);$('[data-action="superscript"]').click();
    assert($('#editor sup')?.textContent==='2','Superscript formats selected rich text');
    content('xn',1,2);$('[data-action="subscript"]').click();
    assert($('#editor sub')?.textContent==='n','Subscript formats selected rich text');
    const formatted='<p>x<sup>2</sup> + a<sub>n</sub> ≤ π</p>';
    assert(sanitize(formatted)===formatted,'Client sanitizer preserves safe math formatting');
    const md=toMarkdown(formatted);
    assert(md.includes('<sup>2</sup>')&&md.includes('<sub>n</sub>'),'Markdown export preserves math formatting');
    assert(fromMarkdown(md)===formatted,'Math formatting survives a Markdown round trip');
    assert(fromMarkdown(String.fromCharCode(96)+'x<sup>2</sup>'+String.fromCharCode(96)).includes('<code>x&lt;sup&gt;2&lt;/sup&gt;</code>'),'Inline code keeps literal script tags');
    const tick=String.fromCharCode(96);
    assert(fromMarkdown('**Use '+tick+'x'+tick+' here**')==='<p><strong>Use <code>x</code> here</strong></p>','Bold text can contain inline code');
    assert(fromMarkdown('['+tick+'x'+tick+'](https://example.com)').includes('<code>x</code></a>'),'Link labels can contain inline code');

    changeEntry({html:'<p>abc DEF ghi</p>'});state.markdown=true;renderEditor(current());
    const mdEditor=$('#markdown-editor');mdEditor.focus();mdEditor.setSelectionRange(4,7);
    await open();symbol('∞').click();$('[data-modal-value="insert"]').click();await settle();
    assert(state.markdown&&mdEditor.value==='abc ∞ ghi','Math insertion preserves Markdown mode and its selection');
    document.execCommand('undo');editorChanged();
    assert(mdEditor.value==='abc DEF ghi','Markdown math insertion can be undone');
    mdEditor.setSelectionRange(4,7);$('[data-action="superscript"]').click();
    assert(mdEditor.value==='abc <sup>DEF</sup> ghi','Superscript works in Markdown mode');
    assert(mdEditor.value.slice(mdEditor.selectionStart,mdEditor.selectionEnd)==='DEF','Markdown formatting keeps its contents selected');
    await flush();
    const persisted=(await api('/api/state')).entries.find(entry=>entry.id===entryId);
    assert(persisted.html.includes('<sup>DEF</sup>'),'Markdown math formatting is persisted');

    state.markdown=false;renderEditor(current());
    const recurrence='T(n) = aT(n/b) + O(n^d)';
    content('Before '+recurrence+' after',7,7+recurrence.length);
    const writingFont=getComputedStyle($('#editor')).fontFamily;
    await open(true);
    assert($('#math-typeset').checked&&$('#math-expression').value===recurrence,'Selected math is prefilled for LaTeX formatting');
    assert(!!$('#math-preview .katex .msupsub'),'Recurrence preview typesets its exponent');
    $('[data-modal-value="insert"]').click();await settle();
    assert(!!$('#editor .diary-equation .katex'),'Inserted equation is rendered');
    assert(getComputedStyle($('#editor')).fontFamily===writingFont&&$('#editor').firstChild.firstChild.textContent.startsWith('Before'),'Only the math changes font; surrounding diary text stays normal');
    assert(!current().html.includes('katex')&&current().html.includes('data-latex='),'Diary saves canonical source instead of rendering markup');
    document.execCommand('undo');editorChanged();
    assert(!$('#editor [data-latex]')&&$('#editor').textContent==='Before '+recurrence+' after','Equation insertion can be undone');
    document.execCommand('redo');editorChanged();
    assert(!!$('#editor .diary-equation .katex'),'Redo restores rendered math');
    await flush();await reload();renderEditor(current());
    assert($('#editor [data-latex]').getAttribute('data-latex')===recurrence&&!!$('#editor .katex'),'Equation survives saving and reopening');
    const mathMarkdown=toMarkdown(current().html);
    assert(mathMarkdown.includes(String.fromCharCode(92)+'('+recurrence+String.fromCharCode(92)+')'),'Markdown export keeps LaTeX delimiters');
    const roundTrip=fromMarkdown(mathMarkdown);
    assert(roundTrip.includes('data-latex="'+recurrence+'"'),'Markdown round trip keeps equation source');
    assert(!fromMarkdown(tick+String.fromCharCode(92)+'(x^2'+String.fromCharCode(92)+')'+tick).includes('data-latex'),'Code containing math delimiters stays literal');

    const beforeEdit=current().html;
    $('#editor [data-latex]').dispatchEvent(new MouseEvent('dblclick',{bubbles:true}));await settle();
    assert($('#math-expression').value===recurrence,'Double-click opens the original source for editing');
    $('#math-expression').value=String.fromCharCode(92)+'frac{';$('#math-expression').dispatchEvent(new Event('input',{bubbles:true}));
    assert($('[data-modal-value="insert"]').disabled&&!!$('#math-error').textContent,'Invalid LaTeX shows an error and cannot be inserted');
    closeModal('cancel');await settle();
    assert(current().html===beforeEdit,'Cancelling equation edit preserves the entry');
    $('#editor [data-latex]').dispatchEvent(new MouseEvent('dblclick',{bubbles:true}));await settle();
    $('#math-expression').value=recurrence.replace('n^d','n^{d+1}');$('#math-expression').dispatchEvent(new Event('input',{bubbles:true}));
    $('[data-modal-value="insert"]').click();await settle();
    assert($$('#editor [data-latex]').length===1&&$('#editor [data-latex]').getAttribute('data-latex').includes('d+1'),'Editing replaces the equation without duplicating it');
    const editedSource=$('#editor [data-latex]').getAttribute('data-latex');
    document.execCommand('insertText',false,'typed after');editorChanged();
    assert($('#editor [data-latex]').getAttribute('data-latex')===editedSource&&serializeEquations($('#editor')).includes('</span>typed after'),'Typing after editing stays outside the math');
    document.execCommand('undo');editorChanged();document.execCommand('undo');editorChanged();
    assert($('#editor [data-latex]')?.getAttribute('data-latex')===recurrence,'Editing an equation can be undone');
    document.execCommand('redo');editorChanged();
    assert($('#editor [data-latex]')?.getAttribute('data-latex')===editedSource,'Editing an equation can be redone');
    await open(true);$('#math-expression').value='';$('#math-expression').setSelectionRange(0,0);symbol('%').click();
    assert($('#math-expression').value===String.fromCharCode(92)+'%'&&$('#math-preview').textContent.includes('%'),'Percent symbol stays visible in LaTeX mode');
    $('#math-expression').value='10%';$('#math-expression').dispatchEvent(new Event('input',{bubbles:true}));
    assert($('[data-modal-value="insert"]').disabled&&$('#math-error').textContent.includes('percent'),'Typed raw percent receives explicit guidance');
    closeModal('cancel');await settle();
    const sourceWithFraction='T(n) = aT('+String.fromCharCode(92)+'frac{n}{b}) + O(n^d)';
    changeEntry({html:'<p>My regular diary text: '+equationHTML(sourceWithFraction)+' and more writing.</p>'});renderEditor(current());await flush();
    assert(!!$('#editor .mfrac'),'LaTeX fractions render correctly');
    assert(textOf(current().html)==='My regular diary text: '+sourceWithFraction+' and more writing.','Plain text includes the math source once');
    let htmlExport='';const originalDownload=download;
    try{download=async blob=>{htmlExport=await blob.text();return true;};await exportEntry('html');}finally{download=originalDownload;}
    assert(htmlExport.includes('data:font/woff2;base64,')&&htmlExport.includes('class="katex"')&&!htmlExport.includes('url(fonts/'),'HTML export bundles rendered math and offline fonts');
    state.markdown=true;renderEditor(current());
    const equationMD=$('#markdown-editor');equationMD.focus();equationMD.setSelectionRange(equationMD.value.length,equationMD.value.length);
    await open(true);$('#math-expression').value='x^2';$('#math-expression').dispatchEvent(new Event('input',{bubbles:true}));
    $('[data-modal-value="insert"]').click();await settle();
    assert(state.markdown&&current().html.includes('data-latex="x^2"'),'Equation insertion works in Markdown mode');
    state.markdown=false;renderEditor(current());state.read=true;
    showMathPicker();assert(!$('#modal').open,'Read-only entries cannot open the math picker');state.read=false;
    await open();
    $('#math-expression').value='中文';$('#math-expression').dispatchEvent(new Event('input',{bubbles:true}));
    $('#math-expression').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',isComposing:true,bubbles:true}));
    assert($('#modal').open,'Chinese input composition does not submit the dialog');
    closeModal('cancel');await settle();
    await open(true);$('#math-expression').value=recurrence;$('#math-expression').dispatchEvent(new Event('input',{bubbles:true}));
    await document.fonts.ready;
    return results;
  })()`,true);
  const screenshot = path.join(root,'work','math-picker-preview.png');
  await fs.mkdir(path.dirname(screenshot),{recursive:true});
  await window.webContents.executeJavaScript('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve())))');
  // Let the offscreen compositor consume queued paints before capturing.
  await new Promise(resolve=>setTimeout(resolve,350));
  const frame = await window.webContents.capturePage(undefined,{stayHidden:true,stayAwake:true});
  await fs.writeFile(screenshot,frame.toPNG());
  if(errors.length)throw new Error(errors.join('\n'));
  console.log(JSON.stringify({passed:results.length,checks:results,screenshot},null,2));
  window.destroy();window=null;
  backend.closeDatabase();backend=null;
  app.exit(0);
})().catch(error=>{console.error(error);if(window&&!window.isDestroyed())window.destroy();backend?.closeDatabase();app.exit(1);});

// The test profile is isolated in the OS temporary directory; never reuse or
// delete a user's diary. The OS may keep Chromium files locked until process exit.
