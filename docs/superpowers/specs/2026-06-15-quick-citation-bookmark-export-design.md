# Diseño — Exportar nodo a Quick Citation (Obsidian) desde el bookmark-editor

**Fecha:** 2026-06-15
**Estado:** Aprobado (luz verde de Federico)
**Versión objetivo:** v0.7.0

## Problema / objetivo

El plugin `zotero-quick-citation` agrega un botón "Citar a Obsidian" sobre *annotations*
del PDF y copia un JSON al portapapeles que el plugin Obsidian Quick Citation lee con su
comando `paste-from-zotero`. Federico quiere el mismo handoff pero disparado desde los
nodos del **bookmark-editor** (índice/outline y marcadores), vía clic derecho.

## Contrato (no cambiar sin actualizar los 3 lados)

El JSON es el contrato entre tres componentes:

1. `zotero-quick-citation` → lo produce desde una annotation (`ZoteroPayload`).
2. **este plugin** → lo produce desde un nodo de outline/bookmark (`QcPayload`).
3. Obsidian quick-citation → lo consume (`parseZoteroClipboard`).

```json
{
  "format": "zotero-quick-citation",
  "version": 1,
  "uuid": "<v4>",
  "text": "<título del nodo>",
  "page": 206,
  "pdfTitle": "Getty tomo 1",
  "zoteroItemKey": "BA226WMI",
  "doi": null,
  "author": null,
  "timestamp": "<ISO>"
}
```

El validador de Obsidian (`parseZoteroClipboard`) exige `format === "zotero-quick-citation"`,
`version === 1`, `uuid` string no vacío y `text` string. Usa `page` (→ página digital),
`text` (→ comentario de la footnote, sanitizado) y `uuid` (→ `zoteroAnnotationUuid`
persistido). **El lado Obsidian NO requiere ningún cambio.**

## Diseño (enfoque elegido: módulo nuevo + wiring en los dos menús)

**Nuevo:** `src/modules/outline/quickCitation.ts`
- `QcPayload` (espejo del contrato).
- `uuidv4()` — sin dependencias (`crypto.getRandomValues`, disponible en Zotero 7).
- `getReaderBibContext()` — del `reader._item` saca `pdfTitle / zoteroItemKey / doi / author`
  con cascada attachment → bibItem; todo defensivo (defaults `""` / `null`).
- `copyTextToClipboard()` — triple fallback: `navigator.clipboard` →
  `Zotero.Utilities.Internal.copyTextToClipboard` → XPCOM (`nsIClipboardHelper`).
- `showToast()` — `ztoolkit.ProgressWindow`, fallback `Zotero.alert`.
- `copyNodeForQuickCitation(doc, kind)` — orquesta: lee título+página del nodo seleccionado
  (`.node-selected`/`.bookmark-selected`), arma el payload, copia JSON, muestra toast.

**Modificado:** `src/modules/outline/events.ts` — un ítem `qc-copy` en cada menú contextual
(outline → `kind:"outline"`, bookmarks → `kind:"bookmark"`), deshabilitado sin selección.

**Locales:** `qc-copy`, `qc-copy-ok`, `qc-copy-failed`, `qc-copy-no-selection` (es-ES + en-US)
y sus claves en `typings/i10n.d.ts`.

## Mapeo de datos

| Campo | Origen |
|---|---|
| `text` | título del nodo (`span.node-title` / `span.bookmark-title`) |
| `page` | attr `page` del nodo (int) o `null` |
| `pdfTitle / zoteroItemKey / doi / author` | item de Zotero del reader (bibItem o attachment) |
| `uuid` | nuevo cada vez (los nodos no tienen tag de annotation para reusar) |
| `timestamp` | `new Date().toISOString()` |

## Manejo de errores

Toda la extracción de metadata va en try/catch con defaults; el payload siempre es válido
(`text` + `uuid` nunca faltan). Si falla el clipboard → toast de error.

## Verificación

No hay harness de tests automatizados (código runtime de Zotero sobre el DOM del reader).
Verificación: `tsc --noEmit` (compila) + repro manual end-to-end — clic derecho en un nodo →
"Copiar para Quick Citation" → en Obsidian `paste-from-zotero` abre el CitationModal con la
página pre-cargada y el comentario = título del nodo.

## Fuera de alcance

- Cambios en el plugin Obsidian (no hacen falta).
- Persistencia del UUID del lado Zotero (los nodos no tienen dónde guardarlo; YAGNI).
