import { getString } from "../../utils/locale";

/**
 * Payload escrito al portapapeles para que lo lea el comando `paste-from-zotero`
 * del plugin Quick Citation en Obsidian.
 *
 * El shape es el CONTRATO entre tres lados y debe mantenerse idéntico:
 *   - este módulo (lo produce desde un nodo de outline/bookmark)
 *   - el plugin `zotero-quick-citation` (ZoteroPayload, lo produce desde una annotation)
 *   - el plugin Obsidian quick-citation (`parseZoteroClipboard`, lo consume)
 * NO cambiar `format`/`version`/campos sin actualizar los tres lados.
 */
export interface QcPayload {
  format: "zotero-quick-citation";
  version: 1;
  uuid: string;
  text: string;
  page: number | null;
  pdfTitle: string;
  zoteroItemKey: string | null;
  doi: string | null;
  author: string | null;
  timestamp: string;
}

interface ToastOptions {
  title: string;
  body?: string;
  type?: "success" | "fail" | "default";
}

/** UUID v4 sin dependencias (crypto.getRandomValues está en el sandbox de Zotero 7). */
function uuidv4(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0"));
  return `${hex.slice(0, 4).join("")}-${hex.slice(4, 6).join("")}-${hex
    .slice(6, 8)
    .join("")}-${hex.slice(8, 10).join("")}-${hex.slice(10, 16).join("")}`;
}

/** Notificación corta vía ProgressWindow del toolkit; fallback a Zotero.alert. */
function showToast(opts: ToastOptions): void {
  try {
    const popup = new ztoolkit.ProgressWindow(getString("plugin-name"), {
      closeOnClick: true,
      closeTime: 2500,
    });
    popup
      .createLine({
        text: opts.body ? `${opts.title} — ${opts.body}` : opts.title,
        type: opts.type ?? "default",
        progress: 100,
      })
      .show();
  } catch {
    try {
      const win = Zotero.getMainWindow();
      if (win) Zotero.alert(win, getString("plugin-name"), opts.title);
    } catch {
      /* silent */
    }
  }
}

/**
 * Copia texto al portapapeles con triple fallback:
 *   1. navigator.clipboard.writeText
 *   2. Zotero.Utilities.Internal.copyTextToClipboard
 *   3. XPCOM bruto (nsIClipboardHelper)
 */
async function copyTextToClipboard(text: string): Promise<boolean> {
  try {
    const nav =
      typeof navigator !== "undefined" ? (navigator as any).clipboard : null;
    if (nav && typeof nav.writeText === "function") {
      await nav.writeText(text);
      return true;
    }
  } catch (err) {
    ztoolkit.log("QC clipboard: navigator.clipboard failed", err);
  }
  try {
    const utils =
      (Zotero as any).Utilities?.Internal ?? (Zotero as any).Utilities;
    if (utils && typeof utils.copyTextToClipboard === "function") {
      utils.copyTextToClipboard(text);
      return true;
    }
  } catch (err) {
    ztoolkit.log("QC clipboard: Zotero.Utilities failed", err);
  }
  try {
    const cls = (Components.classes as any)[
      "@mozilla.org/widget/clipboardhelper;1"
    ];
    const iface = (Components.interfaces as any).nsIClipboardHelper;
    if (cls && iface) {
      cls.getService(iface).copyString(text);
      return true;
    }
  } catch (err) {
    ztoolkit.log("QC clipboard: raw XPCOM failed", err);
  }
  return false;
}

/**
 * Metadata del item de Zotero del reader activo. Cascada attachment → bibItem,
 * espejo de la lógica del plugin `zotero-quick-citation`. Todo defensivo: si algo
 * falla devuelve defaults ("" / null), el payload sigue siendo válido.
 */
function getReaderBibContext(): {
  pdfTitle: string;
  itemKey: string | null;
  doi: string | null;
  author: string | null;
} {
  let pdfTitle = "";
  let itemKey: string | null = null;
  let doi: string | null = null;
  let author: string | null = null;
  try {
    const reader = Zotero.Reader.getByTabID(
      ztoolkit.getGlobal("Zotero_Tabs").selectedID,
    );
    const attachmentItem: any = (reader as any)?._item ?? null;
    const bibItem: any = attachmentItem?.parentItemID
      ? Zotero.Items.get(attachmentItem.parentItemID)
      : null;

    if (bibItem) {
      try {
        pdfTitle =
          (bibItem.getField("title") as string) || bibItem.getDisplayTitle();
      } catch {
        /* silent */
      }
      itemKey = bibItem.key || null;
      try {
        const creators = bibItem.getCreators();
        if (creators && creators.length > 0) {
          const c: any = creators[0];
          author =
            c.lastName && c.firstName
              ? `${c.lastName}, ${c.firstName}`
              : c.lastName || c.firstName || c.name || null;
        }
      } catch {
        /* silent */
      }
      try {
        doi = (bibItem.getField("DOI") as string) || null;
      } catch {
        /* silent */
      }
    } else if (attachmentItem) {
      try {
        pdfTitle =
          (attachmentItem.getField("title") as string) ||
          attachmentItem.getDisplayTitle();
      } catch {
        /* silent */
      }
      itemKey = attachmentItem.key || null;
    }
  } catch (err) {
    ztoolkit.log("QC getReaderBibContext error", err);
  }
  return { pdfTitle, itemKey, doi, author };
}

/**
 * Construye el QcPayload desde el nodo seleccionado (outline o bookmark) + el
 * item de Zotero del reader, lo copia al portapapeles como JSON y muestra un toast.
 *
 * El UUID es nuevo en cada copia: a diferencia de las annotations (que guardan
 * un tag `qc:<uuid>` reusable), los nodos de outline/bookmark no tienen dónde
 * persistir el UUID del lado Zotero. La correlación la guarda Obsidian al pegar.
 */
export async function copyNodeForQuickCitation(
  doc: Document,
  kind: "outline" | "bookmark",
): Promise<void> {
  const sel =
    kind === "outline"
      ? doc.querySelector(".node-selected")
      : doc.querySelector(".bookmark-selected");
  if (!sel) {
    showToast({ title: getString("qc-copy-no-selection"), type: "fail" });
    return;
  }

  const titleSel =
    kind === "outline" ? "span.node-title" : "span.bookmark-title";
  const text = (sel.querySelector(titleSel)?.textContent ?? "").trim();
  const pageAttr = sel.getAttribute("page");
  const page =
    pageAttr != null && /^\d+$/.test(pageAttr) ? parseInt(pageAttr, 10) : null;

  const { pdfTitle, itemKey, doi, author } = getReaderBibContext();

  const payload: QcPayload = {
    format: "zotero-quick-citation",
    version: 1,
    uuid: uuidv4(),
    text,
    page,
    pdfTitle,
    zoteroItemKey: itemKey,
    doi,
    author,
    timestamp: new Date().toISOString(),
  };

  const ok = await copyTextToClipboard(JSON.stringify(payload, null, 2));
  if (ok) {
    showToast({
      title: getString("qc-copy-ok"),
      body: page != null ? `${text} · p.${page}` : text,
      type: "success",
    });
  } else {
    showToast({ title: getString("qc-copy-failed"), type: "fail" });
  }
}
