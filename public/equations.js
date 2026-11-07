'use strict';

// Store only source text. The typesetting is derived locally and never trusted
// as imported HTML or persisted with the diary.
function equationSource(value) {
  const text = String(value ?? '');
  return text.trim() && text.length <= 4000 ? text : null;
}
function equationHTML(source) {
  const span = document.createElement('span');
  span.setAttribute('data-latex',source);
  span.textContent = source;
  return span.outerHTML;
}
function mathOptions() {
  return {displayMode:false,output:'htmlAndMathml',throwOnError:true,trust:false,strict:false,maxSize:20,maxExpand:1000,macros:{}};
}
function renderEquation(source, element) {
  if (/(^|[^\\])(?:\\\\)*%/.test(source)) throw new Error('Use \\% for a percent symbol.');
  katex.render(source,element,mathOptions());
}
function renderEquations(root=document) {
  for (const span of root.querySelectorAll('span[data-latex]')) {
    const source = equationSource(span.getAttribute('data-latex'));
    if (source === null || span.dataset.renderedLatex === source) continue;
    span.className = 'diary-equation';
    span.contentEditable = 'false';
    span.tabIndex = 0;
    span.title = 'Double-click or press Enter to edit this math';
    try { renderEquation(source,span); }
    catch { span.textContent = source; span.classList.add('equation-fallback'); }
    span.dataset.renderedLatex = source;
  }
}
function serializeEquations(root) {
  const copy = root.cloneNode(true);
  for (const span of copy.querySelectorAll('span[data-latex]')) {
    const source = equationSource(span.getAttribute('data-latex'));
    if (source !== null) span.outerHTML = equationHTML(source);
  }
  return copy.innerHTML;
}

// Standalone HTML exports carry their own math fonts, so they work offline too.
let equationExportCSS;
async function exportEquationStyles() {
  if (!equationExportCSS) equationExportCSS = (async()=>{
    const response = await fetch('/vendor/katex/katex.min.css');
    if (!response.ok) throw new Error('The math stylesheet could not be loaded.');
    let css = await response.text();
    const urls = [...new Set([...css.matchAll(/url\(([^)]+)\)/g)].map(match=>match[1]))];
    for (const url of urls) {
      const relative = url.replace(/^['"]|['"]$/g,'');
      if (!/^fonts\/KaTeX_[\w-]+\.woff2$/.test(relative)) throw new Error('Unexpected math font path.');
      const font = await fetch('/vendor/katex/'+relative);
      if (!font.ok) throw new Error('A math font could not be loaded.');
      const data = await blobDataURL(new Blob([await font.arrayBuffer()],{type:'font/woff2'}));
      css = css.split('url('+url+')').join('url("'+data+'")');
    }
    return css+'\n.diary-equation{display:inline-block;max-width:100%;vertical-align:baseline}.diary-equation .katex{font-size:1.1em}';
  })().catch(error=>{equationExportCSS=null;throw error;});
  return equationExportCSS;
}

document.addEventListener('dblclick',event=>{
  const equation=event.target.closest('#editor span[data-latex]');
  if(equation&&!state.read&&!current()?.deletedAt)showMathPicker(equation).catch(fail);
});
document.addEventListener('keydown',event=>{
  if(event.isComposing)return;
  if(event.key==='Enter'&&event.target.matches('#editor span[data-latex]')&&!state.read&&!current()?.deletedAt){
    event.preventDefault();showMathPicker(event.target).catch(fail);
  }
});
