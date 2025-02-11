import {EditorView, ViewPlugin, PluginField, ViewUpdate, BlockType, BlockInfo, Direction} from "@codemirror/view"
import {RangeValue, RangeSet, RangeCursor} from "@codemirror/rangeset"
import {combineConfig, MapMode, Facet, Extension, EditorState} from "@codemirror/state"

/// A gutter marker represents a bit of information attached to a line
/// in a specific gutter. Your own custom markers have to extend this
/// class.
export abstract class GutterMarker extends RangeValue {
  /// @internal
  compare(other: GutterMarker) {
    return this == other || this.constructor == other.constructor && this.eq(other)
  }

  /// Compare this marker to another marker of the same type.
  eq(other: GutterMarker): boolean { return false }

  /// Render the DOM node for this marker, if any.
  toDOM?(_view: EditorView): Node

  /// This property can be used to add CSS classes to the gutter
  /// element that contains this marker.
  elementClass!: string

  /// Called if the marker has a `toDOM` method and its representation
  /// was removed from a gutter.
  destroy(dom: Node) {}
}

GutterMarker.prototype.elementClass = ""
GutterMarker.prototype.toDOM = undefined
GutterMarker.prototype.mapMode = MapMode.TrackBefore
GutterMarker.prototype.startSide = GutterMarker.prototype.endSide = -1
GutterMarker.prototype.point = true

/// Facet used to add a class to all gutter elements for a given line.
/// Markers given to this facet should _only_ define an
/// [`elementclass`](#gutter.GutterMarker.elementClass), not a
/// [`toDOM`](#gutter.GutterMarker.toDOM) (or the marker will appear
/// in all gutters for the line).
export const gutterLineClass = Facet.define<RangeSet<GutterMarker>>()

type Handlers = {[event: string]: (view: EditorView, line: BlockInfo, event: Event) => boolean}

interface GutterConfig {
  /// An extra CSS class to be added to the wrapper (`cm-gutter`)
  /// element.
  class?: string
  /// Controls whether empty gutter elements should be rendered.
  /// Defaults to false.
  renderEmptyElements?: boolean
  /// Retrieve a set of markers to use in this gutter.
  markers?: (view: EditorView) => (RangeSet<GutterMarker> | readonly RangeSet<GutterMarker>[])
  /// Can be used to optionally add a single marker to every line.
  lineMarker?: (view: EditorView, line: BlockInfo, otherMarkers: readonly GutterMarker[]) => GutterMarker | null
  /// If line markers depend on additional state, and should be
  /// updated when that changes, pass a predicate here that checks
  /// whether a given view update might change the line markers.
  lineMarkerChange?: null | ((update: ViewUpdate) => boolean)
  /// Add a hidden spacer element that gives the gutter its base
  /// width.
  initialSpacer?: null | ((view: EditorView) => GutterMarker)
  /// Update the spacer element when the view is updated.
  updateSpacer?: null | ((spacer: GutterMarker, update: ViewUpdate) => GutterMarker)
  /// Supply event handlers for DOM events on this gutter.
  domEventHandlers?: Handlers,
}

const defaults = {
  class: "",
  renderEmptyElements: false,
  elementStyle: "",
  markers: () => RangeSet.empty,
  lineMarker: () => null,
  lineMarkerChange: null,
  initialSpacer: null,
  updateSpacer: null,
  domEventHandlers: {}
}

const activeGutters = Facet.define<Required<GutterConfig>>()

/// Define an editor gutter. The order in which the gutters appear is
/// determined by their extension priority.
export function gutter(config: GutterConfig): Extension {
  return [gutters(), activeGutters.of({...defaults, ...config})]
}

const baseTheme = EditorView.baseTheme({
  ".cm-gutters": {
    display: "flex",
    height: "100%",
    boxSizing: "border-box",
    left: 0,
    zIndex: 200
  },

  "&light .cm-gutters": {
    backgroundColor: "#f5f5f5",
    color: "#999",
    borderRight: "1px solid #ddd"
  },

  "&dark .cm-gutters": {
    backgroundColor: "#333338",
    color: "#ccc"
  },

  ".cm-gutter": {
    display: "flex !important", // Necessary -- prevents margin collapsing
    flexDirection: "column",
    flexShrink: 0,
    boxSizing: "border-box",
    minHeight: "100%",
    overflow: "hidden"
  },

  ".cm-gutterElement": {
    boxSizing: "border-box"
  },

  ".cm-lineNumbers .cm-gutterElement": {
    padding: "0 3px 0 5px",
    minWidth: "20px",
    textAlign: "right",
    whiteSpace: "nowrap"
  },

  "&light .cm-activeLineGutter": {
    backgroundColor: "#e2f2ff"
  },

  "&dark .cm-activeLineGutter": {
    backgroundColor: "#222227"
  }
})

const unfixGutters = Facet.define<boolean, boolean>({
  combine: values => values.some(x => x)
})

/// The gutter-drawing plugin is automatically enabled when you add a
/// gutter, but you can use this function to explicitly configure it.
///
/// Unless `fixed` is explicitly set to `false`, the gutters are
/// fixed, meaning they don't scroll along with the content
/// horizontally (except on Internet Explorer, which doesn't support
/// CSS [`position:
/// sticky`](https://developer.mozilla.org/en-US/docs/Web/CSS/position#sticky)).
export function gutters(config?: {fixed?: boolean}): Extension {
  let result = [
    gutterView,
    baseTheme
  ]
  if (config && config.fixed === false) result.push(unfixGutters.of(true))
  return result
}

const gutterView = ViewPlugin.fromClass(class {
  gutters: SingleGutterView[]
  dom: HTMLElement
  fixed: boolean
  prevViewport: {from: number, to: number}

  constructor(readonly view: EditorView) {
    this.prevViewport = view.viewport
    this.dom = document.createElement("div")
    this.dom.className = "cm-gutters"
    this.dom.setAttribute("aria-hidden", "true")
    this.dom.style.minHeight = this.view.contentHeight + "px"
    this.gutters = view.state.facet(activeGutters).map(conf => new SingleGutterView(view, conf))
    for (let gutter of this.gutters) this.dom.appendChild(gutter.dom)
    this.fixed = !view.state.facet(unfixGutters)
    if (this.fixed) {
      // FIXME IE11 fallback, which doesn't support position: sticky,
      // by using position: relative + event handlers that realign the
      // gutter (or just force fixed=false on IE11?)
      this.dom.style.position = "sticky"
    }
    this.syncGutters(false)
    view.scrollDOM.insertBefore(this.dom, view.contentDOM)
  }

  update(update: ViewUpdate) {
    if (this.updateGutters(update)) {
      // Detach during sync when the viewport changed significantly
      // (such as during scrolling), since for large updates that is
      // faster.
      let vpA = this.prevViewport, vpB = update.view.viewport
      let vpOverlap = Math.min(vpA.to, vpB.to) - Math.max(vpA.from, vpB.from)
      this.syncGutters(vpOverlap < (vpB.to - vpB.from) * 0.8)
    }
    if (update.geometryChanged) this.dom.style.minHeight = this.view.contentHeight + "px"
    if (this.view.state.facet(unfixGutters) != !this.fixed) {
      this.fixed = !this.fixed
      this.dom.style.position = this.fixed ? "sticky" : ""
    }
    this.prevViewport = update.view.viewport
  }

  syncGutters(detach: boolean) {
    let after = this.dom.nextSibling
    if (detach) this.dom.remove()
    let lineClasses = RangeSet.iter(this.view.state.facet(gutterLineClass), this.view.viewport.from)
    let classSet: GutterMarker[] = []
    let contexts = this.gutters.map(gutter => new UpdateContext(gutter, this.view.viewport, -this.view.documentPadding.top))
    let lastLineNum = -1
    for (let line of this.view.viewportLineBlocks) {
      let lineNum = this.view.state.doc.lineAt(line.from).number
      let text: BlockInfo | undefined
      if (Array.isArray(line.type)) {
        for (let b of line.type) if (b.type == BlockType.Text) { text = b; break }
      } else {
        text = line.type == BlockType.Text || lastLineNum < lineNum ? line : undefined
      }
      lastLineNum = lineNum
      if (!text) continue

      if (classSet.length) classSet = []
      advanceCursor(lineClasses, classSet, line.from)
      for (let cx of contexts) cx.line(this.view, text, classSet)
    }
    for (let cx of contexts) cx.finish()
    if (detach) this.view.scrollDOM.insertBefore(this.dom, after)
  }

  updateGutters(update: ViewUpdate) {
    let prev = update.startState.facet(activeGutters), cur = update.state.facet(activeGutters)
    let change = update.docChanged || update.heightChanged || update.viewportChanged ||
      !RangeSet.eq(update.startState.facet(gutterLineClass), update.state.facet(gutterLineClass),
                   update.view.viewport.from, update.view.viewport.to)
    if (prev == cur) {
      for (let gutter of this.gutters) if (gutter.update(update)) change = true
    } else {
      change = true
      let gutters = []
      for (let conf of cur) {
        let known = prev.indexOf(conf)
        if (known < 0) {
          gutters.push(new SingleGutterView(this.view, conf))
        } else {
          this.gutters[known].update(update)
          gutters.push(this.gutters[known])
        }
      }
      for (let g of this.gutters) {
        g.dom.remove()
        if (gutters.indexOf(g) < 0) g.destroy()
      }
      for (let g of gutters) this.dom.appendChild(g.dom)
      this.gutters = gutters
    }
    return change
  }

  destroy() {
    for (let view of this.gutters) view.destroy()
    this.dom.remove()
  }
}, {
  provide: PluginField.scrollMargins.from(value => {
    if (value.gutters.length == 0 || !value.fixed) return null
    return value.view.textDirection == Direction.LTR ? {left: value.dom.offsetWidth} : {right: value.dom.offsetWidth}
  })
})

function asArray<T>(val: T | readonly T[]) { return (Array.isArray(val) ? val : [val]) as readonly T[] }

function advanceCursor(cursor: RangeCursor<GutterMarker>, collect: GutterMarker[], pos: number) {
  while (cursor.value && cursor.from <= pos) {
    if (cursor.from == pos) collect.push(cursor.value)
    cursor.next()
  }
}

function getNextNode(node: Node): Node | null {
  if (node instanceof HTMLElement && node.classList.contains('cm-line')) return node
  if (node.nodeType === Node.TEXT_NODE && node.textContent !== '\u200B') return node.parentNode
  if (node.firstChild) return getNextNode(node.firstChild)
  if (node.nextSibling) return getNextNode(node.nextSibling)
  let parent = node.parentNode
  while (parent) {
    if (parent instanceof Element && parent.classList.contains('cm-line')) return parent
    if (parent.nextSibling) return getNextNode(parent.nextSibling)
    parent = parent.parentNode
  }
  return null
}

class UpdateContext {
  cursor: RangeCursor<GutterMarker>
  localMarkers: GutterMarker[] = []
  i = 0

  constructor(readonly gutter: SingleGutterView, viewport: {from: number, to: number}, public height: number) {
    this.cursor = RangeSet.iter(gutter.markers, viewport.from)
  }

  line(view: EditorView, line: BlockInfo, extraMarkers: readonly GutterMarker[]) {
    if (this.localMarkers.length) this.localMarkers = []
    advanceCursor(this.cursor, this.localMarkers, line.from)
    let localMarkers = extraMarkers.length ? this.localMarkers.concat(extraMarkers) : this.localMarkers
    let forLine = this.gutter.config.lineMarker(view, line, localMarkers)
    if (forLine) localMarkers.unshift(forLine)

    let gutter = this.gutter
    if (localMarkers.length == 0 && !gutter.config.renderEmptyElements) return

    let above = line.top - this.height
    let dom: HTMLElement;
    if (this.i == gutter.elements.length) {
      let newElt = new GutterElement(view, line.height, above, localMarkers)
      gutter.elements.push(newElt)
      gutter.dom.appendChild(newElt.dom)
      dom = newElt.dom
    } else {
      let elt = gutter.elements[this.i]
      elt.update(view, line.height, above, localMarkers)
      dom = elt.dom
    }
    view.requestMeasure({
      read: view => {
        let paddingTop = ''
        let lineHeight = ''
        try {
          let domAtPos = view.domAtPos(line.from)
          let domNode = domAtPos.node.childNodes[domAtPos.offset]
          let lineNode = domNode
          while (lineNode.parentNode && lineNode.parentNode !== view.contentDOM) {
            lineNode = lineNode.parentNode
          }
          paddingTop = getComputedStyle(lineNode).paddingTop
          let node = getNextNode(domNode)
          lineHeight = getComputedStyle(node as HTMLElement).lineHeight
        } catch(e) { }
        return {paddingTop, lineHeight}
      },
      write: ({paddingTop, lineHeight}) => {
        dom.style.paddingTop = paddingTop
        dom.style.lineHeight = lineHeight
      }
    })
    this.height = line.bottom
    this.i++
  }

  finish() {
    let gutter = this.gutter
    while (gutter.elements.length > this.i) {
      let last = gutter.elements.pop()!
      gutter.dom.removeChild(last.dom)
      last.destroy()
    }
  }
}

class SingleGutterView {
  dom: HTMLElement
  elements: GutterElement[] = []
  markers: readonly RangeSet<GutterMarker>[]
  spacer: GutterElement | null = null

  constructor(public view: EditorView, public config: Required<GutterConfig>) {
    this.dom = document.createElement("div")
    this.dom.className = "cm-gutter" + (this.config.class ? " " + this.config.class : "")
    for (let prop in config.domEventHandlers) {
      this.dom.addEventListener(prop, (event: Event) => {
        let line = view.lineBlockAtHeight((event as MouseEvent).clientY - view.documentTop)
        if (config.domEventHandlers[prop](view, line, event)) event.preventDefault()
      })
    }
    this.markers = asArray(config.markers(view))
    if (config.initialSpacer) {
      this.spacer = new GutterElement(view, 0, 0, [config.initialSpacer(view)])
      this.dom.appendChild(this.spacer.dom)
      this.spacer.dom.style.cssText += "visibility: hidden; pointer-events: none"
    }
  }

  update(update: ViewUpdate) {
    let prevMarkers = this.markers
    this.markers = asArray(this.config.markers(update.view))
    if (this.spacer && this.config.updateSpacer) {
      let updated = this.config.updateSpacer(this.spacer.markers[0], update)
      if (updated != this.spacer.markers[0]) this.spacer.update(update.view, 0, 0, [updated])
    }
    let vp = update.view.viewport
    return !RangeSet.eq(this.markers, prevMarkers, vp.from, vp.to) ||
        (this.config.lineMarkerChange ? this.config.lineMarkerChange(update) : false)
  }

  destroy() {
    for (let elt of this.elements) elt.destroy()
  }
}

class GutterElement {
  dom: HTMLElement
  height: number = -1
  above: number = 0
  markers: readonly GutterMarker[] = []

  constructor(view: EditorView, height: number, above: number, markers: readonly GutterMarker[]) {
    this.dom = document.createElement("div")
    this.update(view, height, above, markers)
  }

  update(view: EditorView, height: number, above: number, markers: readonly GutterMarker[]) {
    if (this.height != height)
      this.dom.style.height = (this.height = height) + "px"
    if (this.above != above)
      this.dom.style.marginTop = (this.above = above) ? above + "px" : ""
    if (!sameMarkers(this.markers, markers)) this.setMarkers(view, markers)
  }

  setMarkers(view: EditorView, markers: readonly GutterMarker[]) {
    let cls = "cm-gutterElement", domPos = this.dom.firstChild
    for (let iNew = 0, iOld = 0;;) {
      let skipTo = iOld, marker = iNew < markers.length ? markers[iNew++] : null, matched = false
      if (marker) {
        let c = marker.elementClass
        if (c) cls += " " + c
        for (let i = iOld; i < this.markers.length; i++)
          if (this.markers[i].compare(marker)) { skipTo = i; matched = true; break }
      } else {
        skipTo = this.markers.length
      }
      while (iOld < skipTo) {
        let next = this.markers[iOld++]
        if (next.toDOM) {
          next.destroy(domPos!)
          let after = domPos!.nextSibling
          domPos!.remove()
          domPos = after
        }
      }
      if (!marker) break
      if (marker.toDOM) {
        if (matched) domPos = domPos!.nextSibling
        else this.dom.insertBefore(marker.toDOM(view), domPos)
      }
      if (matched) iOld++
    }
    this.dom.className = cls
    this.markers = markers
  }

  destroy() {
    this.setMarkers(null as any, []) // First argument not used unless creating markers
  }
}

function sameMarkers(a: readonly GutterMarker[], b: readonly GutterMarker[]): boolean {
  if (a.length != b.length) return false
  for (let i = 0; i < a.length; i++) if (!a[i].compare(b[i])) return false
  return true
}

interface LineNumberConfig {
  /// How to display line numbers. Defaults to simply converting them
  /// to string.
  formatNumber?: (lineNo: number, state: EditorState) => string
  /// Supply event handlers for DOM events on this gutter.
  domEventHandlers?: Handlers
}

/// Facet used to provide markers to the line number gutter.
export const lineNumberMarkers = Facet.define<RangeSet<GutterMarker>>()

const lineNumberConfig = Facet.define<LineNumberConfig, Required<LineNumberConfig>>({
  combine(values) {
    return combineConfig<Required<LineNumberConfig>>(values, {formatNumber: String, domEventHandlers: {}}, {
      domEventHandlers(a: Handlers, b: Handlers) {
        let result: Handlers = Object.assign({}, a)
        for (let event in b) {
          let exists = result[event], add = b[event]
          result[event] = exists ? (view, line, event) => exists(view, line, event) || add(view, line, event) : add
        }
        return result
      }
    })
  }
})

class NumberMarker extends GutterMarker {
  constructor(readonly number: string) { super() }

  eq(other: NumberMarker) { return this.number == other.number }

  toDOM() { return document.createTextNode(this.number) }
}

function formatNumber(view: EditorView, number: number) {
  return view.state.facet(lineNumberConfig).formatNumber(number, view.state)
}

const lineNumberGutter = activeGutters.compute([lineNumberConfig], state => ({
  class: "cm-lineNumbers",
  renderEmptyElements: false,
  markers(view: EditorView) { return view.state.facet(lineNumberMarkers) },
  lineMarker(view, line, others) {
    if (others.some(m => m.toDOM)) return null
    return new NumberMarker(formatNumber(view, view.state.doc.lineAt(line.from).number))
  },
  lineMarkerChange: update => update.startState.facet(lineNumberConfig) != update.state.facet(lineNumberConfig),
  initialSpacer(view: EditorView) {
    return new NumberMarker(formatNumber(view, maxLineNumber(view.state.doc.lines)))
  },
  updateSpacer(spacer: GutterMarker, update: ViewUpdate) {
    let max = formatNumber(update.view, maxLineNumber(update.view.state.doc.lines))
    return max == (spacer as NumberMarker).number ? spacer : new NumberMarker(max)
  },
  domEventHandlers: state.facet(lineNumberConfig).domEventHandlers
}))

/// Create a line number gutter extension.
export function lineNumbers(config: LineNumberConfig = {}): Extension {
  return [
    lineNumberConfig.of(config),
    gutters(),
    lineNumberGutter
  ]
}

function maxLineNumber(lines: number) {
  let last = 9
  while (last < lines) last = last * 10 + 9
  return last
}

const activeLineGutterMarker = new class extends GutterMarker {
  elementClass = "cm-activeLineGutter"
}

const activeLineGutterHighlighter = gutterLineClass.compute(["selection"], state => {
  let marks = [], last = -1
  for (let range of state.selection.ranges) if (range.empty) {
    let linePos = state.doc.lineAt(range.head).from
    if (linePos > last) {
      last = linePos
      marks.push(activeLineGutterMarker.range(linePos))
    }
  }
  return RangeSet.of(marks)
})

/// Returns an extension that adds a `cm-activeLineGutter` class to
/// all gutter elements on the [active
/// line](#view.highlightActiveLine).
export function highlightActiveLineGutter() {
  return activeLineGutterHighlighter
}
