// canvas writing pad for Apple Pencil / finger (pressure, palm rejection, undo)
export class HandwritingPad {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.strokes = [];
    this.current = null;
    this.drawing = false;
    this.penSeen = false;
    this.ink = '#15233a';
    this._bindEvents();
    // size on the next frame, after layout
    requestAnimationFrame(() => this.resize());
  }

  resize() {
    const rect = this.canvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const dpr = window.devicePixelRatio || 1;
    this.canvas.width = Math.round(rect.width * dpr);
    this.canvas.height = Math.round(rect.height * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.ctx.lineCap = 'round';
    this.ctx.lineJoin = 'round';
    this.ctx.strokeStyle = this.ink;
    this.w = rect.width;
    this.h = rect.height;
    this.redraw();
  }

  _pos(e) {
    const r = this.canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top, p: e.pressure > 0 ? e.pressure : 0.5 };
  }

  _bindEvents() {
    this.canvas.style.touchAction = 'none';
    const down = (e) => {
      if (e.pointerType === 'pen') this.penSeen = true;
      if (this.penSeen && e.pointerType === 'touch') return; // palm rejection
      try { this.canvas.setPointerCapture(e.pointerId); } catch {}
      this.drawing = true;
      this.current = [this._pos(e)];
      e.preventDefault();
    };
    const move = (e) => {
      if (!this.drawing) return;
      if (this.penSeen && e.pointerType === 'touch') return;
      const evs = e.getCoalescedEvents ? e.getCoalescedEvents() : [e];
      for (const ev of evs) { this.current.push(this._pos(ev)); }
      this._drawTail();
      e.preventDefault();
    };
    const up = () => {
      if (!this.drawing) return;
      this.drawing = false;
      if (this.current && this.current.length) this.strokes.push(this.current);
      this.current = null;
    };
    this.canvas.addEventListener('pointerdown', down);
    this.canvas.addEventListener('pointermove', move);
    this.canvas.addEventListener('pointerup', up);
    this.canvas.addEventListener('pointercancel', up);
    this.canvas.addEventListener('pointerleave', up);
  }

  _segWidth(p) { return Math.max(1.6, 4.2 * (p || 0.5)); }

  _drawTail() {
    const s = this.current;
    if (!s || s.length < 2) return;
    const a = s[s.length - 2];
    const b = s[s.length - 1];
    this.ctx.lineWidth = this._segWidth(b.p);
    this.ctx.beginPath();
    this.ctx.moveTo(a.x, a.y);
    this.ctx.lineTo(b.x, b.y);
    this.ctx.stroke();
  }

  redraw() {
    if (!this.w) return;
    this.ctx.clearRect(0, 0, this.w, this.h);
    for (const s of this.strokes) {
      for (let i = 1; i < s.length; i++) {
        this.ctx.lineWidth = this._segWidth(s[i].p);
        this.ctx.beginPath();
        this.ctx.moveTo(s[i - 1].x, s[i - 1].y);
        this.ctx.lineTo(s[i].x, s[i].y);
        this.ctx.stroke();
      }
    }
  }

  clear() { this.strokes = []; this.current = null; this.redraw(); }
  undo() { this.strokes.pop(); this.redraw(); }
  isEmpty() { return this.strokes.length === 0; }
}
