/**
 * AC2/AC3 — `UIPanel` is one of the three typed hook interfaces this package exports.
 * Serializable-data-only render result per architecture.md § Data Boundaries — an extension
 * returns markup/data for core to render, it never receives a live DOM/component reference.
 */
export type UIPanelContext = {
  /** Which named panel slot core is asking the extension to render into. */
  slot: string
}

export type UIPanelResult = {
  /** Serializable HTML fragment for core to render into the requested slot. */
  html: string
}

export type UIPanel = {
  onRenderPanel(context: UIPanelContext): Promise<UIPanelResult>
}
