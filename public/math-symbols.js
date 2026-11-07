'use strict';

// Unicode stays editable, searchable, and portable across diary exports.
const mathSymbolGroups = [
  { name: 'Common', symbols: [
    ['+', 'Plus addition'], ['−', 'Minus subtraction'], ['×', 'Times multiplication'], ['÷', 'Division'],
    ['=', 'Equals'], ['≠', 'Not equal'], ['≈', 'Approximately equal'], ['±', 'Plus or minus'],
    ['<', 'Less than'], ['>', 'Greater than'], ['≤', 'Less than or equal'], ['≥', 'Greater than or equal'],
    ['∞', 'Infinity'], ['√', 'Square root radical'], ['π', 'Pi'], ['°', 'Degree'],
    ['%', 'Percent'], ['·', 'Middle dot multiplication'], ['∑', 'Summation sigma'], ['∫', 'Integral']
  ]},
  { name: 'Greek letters', symbols: [
    ['α', 'Alpha'], ['β', 'Beta'], ['γ', 'Gamma'], ['δ', 'Delta'], ['ε', 'Epsilon'], ['ζ', 'Zeta'],
    ['η', 'Eta'], ['θ', 'Theta'], ['ι', 'Iota'], ['κ', 'Kappa'], ['λ', 'Lambda'], ['μ', 'Mu'],
    ['ν', 'Nu'], ['ξ', 'Xi'], ['ο', 'Omicron'], ['π', 'Pi'], ['ρ', 'Rho'], ['σ', 'Sigma'],
    ['τ', 'Tau'], ['υ', 'Upsilon'], ['φ', 'Phi'], ['χ', 'Chi'], ['ψ', 'Psi'], ['ω', 'Omega'],
    ['Γ', 'Capital gamma'], ['Δ', 'Capital delta'], ['Θ', 'Capital theta'], ['Λ', 'Capital lambda'],
    ['Ξ', 'Capital xi'], ['Π', 'Capital pi'], ['Σ', 'Capital sigma'], ['Φ', 'Capital phi'],
    ['Ψ', 'Capital psi'], ['Ω', 'Capital omega']
  ]},
  { name: 'Operators & calculus', symbols: [
    ['∓', 'Minus or plus'], ['∝', 'Proportional to'], ['≡', 'Identical equivalent'], ['≅', 'Congruent'],
    ['≪', 'Much less than'], ['≫', 'Much greater than'], ['∣', 'Divides'], ['∤', 'Does not divide'],
    ['∑', 'Summation sigma'], ['∏', 'Product pi'], ['∐', 'Coproduct'], ['∂', 'Partial derivative'],
    ['∇', 'Nabla gradient del'], ['∫', 'Integral'], ['∬', 'Double integral'], ['∭', 'Triple integral'],
    ['∮', 'Contour integral'], ['√', 'Square root'], ['∛', 'Cube root'], ['∜', 'Fourth root'],
    ['′', 'Prime derivative'], ['″', 'Double prime'], ['∆', 'Increment delta'], ['ℓ', 'Script small l']
  ]},
  { name: 'Sets & logic', symbols: [
    ['∈', 'Element of member'], ['∉', 'Not an element of'], ['∋', 'Contains as member'], ['∅', 'Empty set'],
    ['⊂', 'Proper subset'], ['⊃', 'Proper superset'], ['⊆', 'Subset or equal'], ['⊇', 'Superset or equal'],
    ['∪', 'Union'], ['∩', 'Intersection'], ['∖', 'Set difference'], ['ℕ', 'Natural numbers'],
    ['ℤ', 'Integers'], ['ℚ', 'Rational numbers'], ['ℝ', 'Real numbers'], ['ℂ', 'Complex numbers'],
    ['∀', 'For all universal'], ['∃', 'There exists'], ['∄', 'There does not exist'], ['¬', 'Not negation'],
    ['∧', 'Logical and'], ['∨', 'Logical or'], ['⊕', 'Exclusive or direct sum'], ['⊗', 'Tensor product'],
    ['⊤', 'True top'], ['⊥', 'False bottom perpendicular'], ['∴', 'Therefore'], ['∵', 'Because']
  ]},
  { name: 'Arrows & geometry', symbols: [
    ['←', 'Left arrow'], ['→', 'Right arrow tends to'], ['↔', 'Left right arrow'], ['↑', 'Up arrow'],
    ['↓', 'Down arrow'], ['↦', 'Maps to'], ['⇒', 'Implies right double arrow'], ['⇐', 'Implied by left double arrow'],
    ['⇔', 'If and only if equivalent'], ['↗', 'North east arrow'], ['↘', 'South east arrow'], ['∠', 'Angle'],
    ['∡', 'Measured angle'], ['⊥', 'Perpendicular'], ['∥', 'Parallel'], ['△', 'Triangle'],
    ['○', 'Circle'], ['□', 'Square'], ['⌈', 'Left ceiling'], ['⌉', 'Right ceiling'],
    ['⌊', 'Left floor'], ['⌋', 'Right floor'], ['⟨', 'Left angle bracket'], ['⟩', 'Right angle bracket'],
    ['…', 'Horizontal ellipsis'], ['⋯', 'Centered ellipsis'], ['⋮', 'Vertical ellipsis'], ['⋱', 'Diagonal ellipsis']
  ]},
  { name: 'Powers & subscripts', symbols: [
    ['⁰', 'Superscript zero'], ['¹', 'Superscript one'], ['²', 'Squared superscript two'], ['³', 'Cubed superscript three'],
    ['⁴', 'Superscript four'], ['⁵', 'Superscript five'], ['⁶', 'Superscript six'], ['⁷', 'Superscript seven'],
    ['⁸', 'Superscript eight'], ['⁹', 'Superscript nine'], ['ⁿ', 'Superscript n'], ['ⁱ', 'Superscript i'],
    ['⁺', 'Superscript plus'], ['⁻', 'Superscript minus'], ['⁽', 'Superscript left parenthesis'], ['⁾', 'Superscript right parenthesis'],
    ['₀', 'Subscript zero'], ['₁', 'Subscript one'], ['₂', 'Subscript two'], ['₃', 'Subscript three'],
    ['₄', 'Subscript four'], ['₅', 'Subscript five'], ['₆', 'Subscript six'], ['₇', 'Subscript seven'],
    ['₈', 'Subscript eight'], ['₉', 'Subscript nine'], ['ₙ', 'Subscript n'], ['ₓ', 'Subscript x'],
    ['₊', 'Subscript plus'], ['₋', 'Subscript minus'], ['₍', 'Subscript left parenthesis'], ['₎', 'Subscript right parenthesis']
  ]},
  { name: 'Fractions', symbols: [
    ['½', 'One half'], ['⅓', 'One third'], ['⅔', 'Two thirds'], ['¼', 'One quarter fourth'],
    ['¾', 'Three quarters fourths'], ['⅕', 'One fifth'], ['⅖', 'Two fifths'], ['⅗', 'Three fifths'],
    ['⅘', 'Four fifths'], ['⅙', 'One sixth'], ['⅚', 'Five sixths'], ['⅛', 'One eighth'],
    ['⅜', 'Three eighths'], ['⅝', 'Five eighths'], ['⅞', 'Seven eighths'], ['⁄', 'Fraction slash']
  ]}
];

const mathExamples = [
  ['x²', 'Squared'], ['xₙ', 'Subscript'], ['a/b', 'Fraction'], ['√(x)', 'Square root'],
  ['∑ᵢ₌₁ⁿ xᵢ', 'Sum'], ['∫ f(x) dx', 'Integral'], ['α + β', 'Greek letters'], ['a² + b² = c²', 'Pythagorean theorem']
];

async function showMathPicker(editingEquation=null) {
  const entry = current();
  if (!entry || entry.deletedAt || state.read) return;
  const markdown = state.markdown;
  const editor = $(markdown ? '#markdown-editor' : '#editor');
  if (!editor) return;
  const entryId = entry.id;
  const start = markdown ? editor.selectionStart : 0;
  const end = markdown ? editor.selectionEnd : 0;
  const selection = getSelection();
  const liveRange = selection?.rangeCount ? selection.getRangeAt(0) : null;
  const candidate = liveRange && editor.contains(liveRange.commonAncestorContainer) ? liveRange : selectionRange;
  let range = !markdown && candidate && editor.contains(candidate.commonAncestorContainer) ? candidate.cloneRange() : null;
  if(editingEquation?.matches?.('span[data-latex]')&&editor.contains(editingEquation)){
    range=document.createRange();range.selectNode(editingEquation);
  }else editingEquation=null;
  const selectedText=markdown?editor.value.slice(start,end):range?.toString()||'';
  const initialExpression=editingEquation?.getAttribute('data-latex')||selectedText;

  const result = modal('Insert math', `
    <div class="math-picker">
      <p class="muted math-intro">Choose symbols or type an expression. It will be inserted at your cursor, replacing any selected text.</p>
      <div class="math-search-row">
        <label class="form-row">Find a symbol<input autofocus id="math-search" class="form-input" type="search" placeholder="Try pi, integral, infinity…" autocomplete="off"></label>
        <label class="form-row">Category<select id="math-category" class="form-input"><option value="all">All symbols</option>${mathSymbolGroups.map((group,index)=>`<option value="${index}">${esc(group.name)}</option>`).join('')}</select></label>
      </div>
      <div class="math-results-label"><span id="math-result-count" role="status"></span><span>Click a symbol to add it below</span></div>
      <div id="math-symbol-grid" class="math-symbol-grid" role="group" aria-label="Mathematical symbols"></div>
      <div class="math-examples" role="group" aria-label="Expression starters"><span>Start with</span>${mathExamples.map(([value,name])=>`<button type="button" class="math-example" data-math-value="${esc(value)}" title="${esc(name)}" aria-label="Add ${esc(name.toLowerCase())} expression">${esc(value)}</button>`).join('')}</div>
      <label class="form-row math-expression-label">Your symbol or expression<input id="math-expression" class="form-input" name="mathExpression" maxlength="4000" value="${esc(initialExpression.slice(0,4000))}" spellcheck="false" autocomplete="off" placeholder="T(n) = aT(n/b) + O(n^d)" aria-describedby="math-expression-help"></label>
      <label class="check-label math-typeset-option"><input id="math-typeset" type="checkbox" name="mathTypeset" checked> Use LaTeX-style math</label>
      <div class="math-preview-label">PREVIEW</div><div id="math-preview" class="math-preview" aria-label="Math preview"></div><p id="math-error" class="math-error" role="status"></p>
      <p id="math-expression-help" class="muted math-help">Only this math gets the math font. Use ^ for powers, _ for subscripts, or LaTeX such as \\frac{n}{b}. Double-click inserted math to edit it.</p>
    </div>`, [{label:'Cancel',value:'cancel'},{label:'Insert',value:'insert',primary:true}], true);

  const dialog = $('#modal');
  const search = $('#math-search');
  const category = $('#math-category');
  const grid = $('#math-symbol-grid');
  const expression = $('#math-expression');
  const insertButton = $('[data-modal-value="insert"]',dialog);
  insertButton.disabled = true;
  function renderSymbols() {
    const query = search.value.trim().toLocaleLowerCase();
    const groups = category.value === 'all' ? mathSymbolGroups : [mathSymbolGroups[Number(category.value)]];
    const seen = new Set();
    const symbols = groups.flatMap(group=>group.symbols).filter(([value,name])=>{
      if (seen.has(value)) return false;
      seen.add(value);
      return !query || `${value} ${name}`.toLocaleLowerCase().includes(query);
    });
    $('#math-result-count').textContent = `${symbols.length} symbol${symbols.length===1?'':'s'}`;
    grid.innerHTML = symbols.length ? symbols.map(([value,name])=>`<button type="button" class="math-symbol" data-math-value="${esc(value)}" title="${esc(name)} (${esc(value)})" aria-label="${esc(name)} (${esc(value)})">${esc(value)}</button>`).join('') : '<p class="math-no-results">No symbols found. Try another name or choose All symbols.</p>';
    grid.scrollTop = 0;
  }
  search.addEventListener('input',renderSymbols);
  // Enter in search should not submit an unfinished expression.
  search.addEventListener('keydown',event=>{if(event.key==='Enter'){event.preventDefault();event.stopPropagation();}});
  category.addEventListener('change',renderSymbols);
  const typeset=$('#math-typeset');
  const preview=$('#math-preview');
  const error=$('#math-error');
  const updateInsert = () => {
    error.textContent='';insertButton.disabled=!expression.value.trim();
    preview.classList.toggle('plain-math-preview',!typeset.checked);
    if(!expression.value.trim()){preview.textContent='Your math will appear here.';return;}
    if(!typeset.checked){preview.textContent=expression.value;return;}
    try{renderEquation(expression.value,preview);}
    catch(problem){preview.textContent=expression.value;error.textContent='Check your math: '+problem.message.replace(/^KaTeX parse error:\s*/, '').slice(0,240);insertButton.disabled=true;}
  };
  typeset.addEventListener('change',updateInsert);
  expression.addEventListener('input',updateInsert);
  $('.math-picker',dialog).addEventListener('click',event=>{
    const button = event.target.closest('[data-math-value]');
    if (!button) return;
    const value = typeset.checked&&button.dataset.mathValue==='%'?'\\%':button.dataset.mathValue;
    if (expression.value.length - (expression.selectionEnd-expression.selectionStart) + value.length > expression.maxLength) return;
    expression.setRangeText(value,expression.selectionStart,expression.selectionEnd,'end');
    expression.focus();
    updateInsert();
  });
  renderSymbols();
  updateInsert();

  const response = await result;
  if (state.selected !== entryId || state.markdown !== markdown || state.read || current()?.deletedAt || !editor.isConnected) return;
  editor.focus();
  if (markdown) editor.setSelectionRange(start,end);
  else {
    const restored = range || document.createRange();
    if (!range) { restored.selectNodeContents(editor); restored.collapse(false); }
    const selected = getSelection();
    selected.removeAllRanges();
    selected.addRange(restored);
    selectionRange = restored.cloneRange();
  }
  if (response.value !== 'insert' || !response.fields.mathExpression?.trim()) return;
  // Native insertion preserves the editor's undo history in Electron/Chromium.
  const source=response.fields.mathExpression;
  let insertedMath=null;
  if(response.fields.mathTypeset){
    // Validate again at the boundary; imported or pasted source is never HTML.
    renderEquation(source,document.createElement('span'));
    if(markdown)document.execCommand('insertText',false,'\\('+source+'\\)');
    else {
      const existing=new Set(editor.querySelectorAll('span[data-latex]'));
      document.execCommand('insertHTML',false,equationHTML(source)+(editingEquation?'':' '));
      insertedMath=[...editor.querySelectorAll('span[data-latex]')].find(span=>!existing.has(span));
    }
  }else document.execCommand('insertText',false,source);
  editorChanged();
  // Typesetting replaces the equation's children. Keep the typing position
  // outside that non-editable subtree, including when replacing old math.
  if(insertedMath?.isConnected){
    const cursor=document.createRange();cursor.setStartAfter(insertedMath);
    const next=insertedMath.nextSibling;
    if(!editingEquation&&next?.nodeType===3&&/^[ \u00a0]/.test(next.textContent))cursor.setStart(next,1);
    cursor.collapse(true);const selected=getSelection();selected.removeAllRanges();selected.addRange(cursor);selectionRange=cursor.cloneRange();
  }
}

function formatMathScript(tag) {
  if (!['sup','sub'].includes(tag) || state.read || current()?.deletedAt) return;
  if (!state.markdown) { command(tag==='sup'?'superscript':'subscript'); return; }
  const editor = $('#markdown-editor');
  if (!editor) return;
  const start = editor.selectionStart, end = editor.selectionEnd;
  const selected = editor.value.slice(start,end);
  editor.focus();
  document.execCommand('insertText',false,`<${tag}>${selected}</${tag}>`);
  editor.setSelectionRange(start+tag.length+2,start+tag.length+2+selected.length);
  editorChanged();
}
