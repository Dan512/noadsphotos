// js/i18n.js — i18n core: TRANSLATIONS dict + t() helper + setLanguage().
//
// Pattern:
//   - One canonical EN dictionary, 14 stub dictionaries with EN fallback.
//   - `t(key, vars?)` does the lookup; variable interpolation is HTML-escaped
//     so the result is safe to assign to innerHTML.
//   - `setLanguage(code)` writes localStorage, sets <html lang>/dir, and walks
//     [data-i18n] / [data-i18n-attr] nodes to re-translate them.
//   - The language code is allowlist-sanitized — only the 15 codes in `LANGS`
//     are honored. Anything else (including XSS attempts via localStorage)
//     falls back to 'en'.
//
// EN is the canonical source. Other languages can be empty (`{}`) and will
// fall back to EN — they get filled in by AI translation in a follow-up pass.
import { escapeHtml, pickFromAllowlist } from './escape.js';

export const LANGS = Object.freeze([
  'en', 'es', 'de', 'fr', 'it', 'pt', 'nl', 'pl',
  'ja', 'zh-CN', 'ko', 'ru', 'ar', 'hi', 'tr',
]);

// Per-language native display names for the picker (rendered next to the flag).
export const LANG_NAMES = Object.freeze({
  en: 'English',     es: 'Español',     de: 'Deutsch',     fr: 'Français',
  it: 'Italiano',    pt: 'Português',   nl: 'Nederlands',  pl: 'Polski',
  ja: '日本語',       'zh-CN': '中文',     ko: '한국어',       ru: 'Русский',
  ar: 'العربية',      hi: 'हिन्दी',         tr: 'Türkçe',
});

// Languages that need RTL layout. Used to flip `dir` on <html>.
export const RTL_LANGS = new Set(['ar']);

// TRANSLATIONS: { [langCode]: { [key]: 'translated string' } }
// EN is the canonical source. Other languages can be empty (`{}`) and will
// fall back to EN at lookup time.
export const TRANSLATIONS = {
  en: {
    // --- Brand / chrome ----------------------------------------------------
    brandName:                'NoAdsPhotos',
    language:                 'Language',
    settings:                 'Settings',
    themeToggle:              'Toggle theme',
    tip:                      'Support this site',
    tipShort:                 'Support',
    tipFooter:                'Support this site',
    privacy:                  'Privacy',
    source:                   'Source',
    home:                     'Home',
    notFoundTitle:            'Not found',
    notFoundBody:             "That page doesn't exist on this site.",
    notFoundReturn:           'Return home',

    // --- Queue view --------------------------------------------------------
    queueEmptyDragHint:       'Drag images here, or paste, or',
    queueEmptyClickToBrowse:  'click to browse',
    queueOpenImage:           'Open {name}',
    queueRemoveImage:         'Remove {name}',
    queueBatchBadge:          'batch',

    // --- Queue intro (empty-state landing copy) ---------------------------
    // Rendered above the drop zone when the queue is empty. The introTitle
    // becomes the single content <h1> on the page.
    introTitle:               'Batch image editing in your browser.',
    introLead:                'Resize, crop, adjust, redact, remove backgrounds, and export PNG, JPG, or WebP. Image files never leave your device.',
    introTags:                'Free · No signup · Open source',
    introFeatureBatch:        'Batch resize and export — save images as a ZIP',
    introFeatureBgRemove:     'Remove backgrounds — no upload required',
    introFeatureRedact:       'Redact details — blur or pixelate selected areas',
    introFeatureChromakey:    'Make colors transparent — eyedropper with tolerance',
    introFeatureExport:       'Export PNG, JPG, or WebP — control quality per image',

    // --- Batch panel -------------------------------------------------------
    batchPanelLabel:          'Batch operations',
    batchApplyToAll:          'Apply to all',
    batchSectionResize:       'Resize',
    batchSectionRotate:       'Rotate / Flip',
    batchSectionAdjust:       'Adjust',
    batchSectionChroma:       'Color to transparent',
    batchSectionBg:           'Background remove',
    batchSectionExport:       'Export',
    batchResizeApply:         'Apply resize to all',
    batchAdjustApply:         'Apply adjust to all',
    batchChromaApply:         'Apply chromakey to all',
    batchBgHint:              'Removes the background from every image. Uses local AI; the model loads on this device the first time. Subsequent runs are quick.',
    batchBgRun:               'Run on all queue images',
    batchBgRunAria:           'Apply background removal to all queue images',
    batchExportZip:           'Export queue (ZIP)',
    batchExportZipAria:       'Export the entire queue as a ZIP',
    batchExportEach:          'Export each as separate files',
    batchExportEachAria:      'Export each image in the queue as an individual file download',
    batchExportAsAria:        'Export queue as {label}',
    batchModeAria:            'Batch resize mode',
    batchValueAria:           'Batch resize value',
    batchHeightAria:          'Batch resize exact height',
    batchSliderAria:          'Batch {key}',
    batchPresetAria:          'Batch filter preset',
    batchChromaColorAria:     'Batch chromakey color',
    batchChromaTolAria:       'Batch chromakey tolerance',
    batchQualityAria:         'Batch export quality',
    batchFilenameAria:        'Batch filename template',
    batchFilenameHelp:        '{base} = original filename · {n} = zero-padded index · {ext} = png|jpg|webp',
    batchReadoutSingular:     '{count} image · ~{mb} MB estimated',
    batchReadoutPlural:       '{count} images · ~{mb} MB estimated',
    batchToastResizeCleared:  'Resize cleared on {count} images.',
    batchToastResizeApplied:  'Resize applied to {count} images.',
    batchToastRotated:        'Rotated {count} images.',
    batchToastFlipped:        'Flipped {count} images.',
    batchToastAdjusted:       'Adjust applied to {count} images.',
    batchToastChromakey:      'Color-to-transparent applied to {count} images.',
    batchToastResizeInvalid:  'Enter a positive number for the resize value.',
    batchProgressBgLabel:     'Background removal progress',
    batchProgressBgTitleSingular: 'Removing background from {count} image…',
    batchProgressBgTitlePlural:   'Removing background from {count} images…',
    batchProgressExportLabel: 'Batch export progress',
    batchProgressExportTitleSingular: 'Exporting {count} image…',
    batchProgressExportTitlePlural:   'Exporting {count} images…',
    batchProgressBuildingZip: 'Building ZIP…',
    batchProgressCompressingFiles: 'Compressing files…',
    batchProgressCompressingPct: 'Compressing… {percent}%',
    batchProgressWorking:     'Working…',
    batchProgressCancelling:  'Cancelling…',
    batchProgressCancel:      'Cancel',
    batchProgressQueued:      'queued',
    batchProgressEncoding:    'removing…',
    batchProgressDone:        'done',
    batchProgressFailed:      'failed',
    batchProgressSkipped:     'skipped',
    batchProgressCountOf:     '{done} / {total}',
    batchBgCancelled:         'Background removal cancelled.',
    batchBgPartial:           'Background removed on {count} images ({failed} failed).',
    batchBgDone:              'Background removed on {count} images.',
    batchConfirmHuge:         '{count} images, ~{mb} MB estimated output. This may take a while or run out of memory on phones.',
    batchConfirmHugeIndividual: '{count} images will be downloaded as separate files. Your browser may prompt you to allow multiple downloads.',
    batchConfirmHeadsUp:      'Heads up',
    batchConfirmContinue:     'Continue',
    batchConfirmCancel:       'Cancel',

    // --- Editor toolbar / chrome ------------------------------------------
    editorPanelsLabel:        'Editor panels',
    editorToolSelect:         'Select',
    editorToolCrop:           'Crop',
    editorToolText:           'Text',
    editorToolBrush:          'Brush',
    editorToolShape:          'Shape',
    editorToolRedact:         'Redact',
    editorToolEyedropper:     'Eyedropper',
    editorToolBgRemove:       'Remove background',
    editorUndo:               'Undo',
    editorRedo:               'Redo',
    editorBackToQueue:        'Back to queue',
    editorBackToQueueLabel:   '← Queue',
    editorZoomPresetAria:     'Zoom preset',
    editorZoomFit:            'Fit',
    editorZoomOut:            'Zoom out',
    editorZoomIn:             'Zoom in',

    // --- Side panel section titles ----------------------------------------
    panelToolOptions:         'Tool options',
    panelResize:              'Resize',
    panelAdjust:              'Adjust',
    panelOverlays:            'Overlays',
    panelExport:              'Export',

    // --- Mobile panel section tabs (Phase 13/14) --------------------------
    // Short labels used by the editor's panel tabs on mobile. They mirror
    // the desktop panel headings above but trim the verbose "Tool options"
    // down to "Tool" so the row fits comfortably on a narrow phone
    // viewport. Phase 14 dropped the bottom-sheet trigger button, so its
    // label was removed.
    tab_tool:                 'Tool',
    tab_resize:               'Resize',
    tab_adjust:               'Adjust',
    tab_overlays:             'Overlays',
    tab_export:               'Export',

    // --- Resize panel -----------------------------------------------------
    resizeMode:               'Mode',
    resizeModeAria:           'Resize mode',
    resizeValue:              'Value',
    resizeValueAria:          'Resize value',
    resizeHeight:             'Height',
    resizeHeightAria:         'Resize exact height',
    resizeLockAria:           'Lock aspect ratio',
    resizeLock:               'Lock aspect ratio',
    resizeOutput:             'Output: {w} × {h} px',
    resizeOutputEmpty:        'Output: —',
    resizeModeFree:           'Free (original)',
    resizeModeLongest:        'Long side',
    resizeModeShortest:       'Short side',
    resizeModeWidth:          'Width',
    resizeModeHeightLabel:    'Height',
    resizeModePercent:        'Percent',
    resizeModeExact:          'Exact (W × H)',

    // --- Trim / auto-crop (v1.1 Feature 3) --------------------------------
    // Two buttons in the Resize panel (and in the batch panel) that crop
    // out transparent or solid-color edges. The bake is destructive — it
    // commits current adjustments and masks into the source bitmap — so
    // the tooltip says so and the success toast quantifies the change.
    trimTransparentBtn:       'Trim transparent edges',
    trimTransparentAria:      'Crop to non-transparent content (commits current edits to the source)',
    trimColorBtn:             'Trim background color (top-left pixel)',
    trimColorAria:            'Crop to non-background-color content (commits current edits)',
    trimToleranceLabel:       'Tolerance',
    trimToleranceAria:        'Color match tolerance for trim',
    trimEmpty:                'Image is entirely transparent (or matches the background color); nothing to trim.',
    trimSuccess:              'Trimmed {fromW}×{fromH} → {toW}×{toH}',
    trimNoChange:             'No trimmable edges found.',
    trimTooltip:              'Find the bounding box of non-transparent or non-background content and crop to it. Commits current edits to the source pixels.',
    batchSectionTrim:         'Trim',
    batchTrimTransparentApply:'Trim transparent edges (all)',
    batchTrimColorApply:      'Trim background color (all)',
    batchToastTrimmed:        'Trimmed {count} images.',
    batchToastTrimSkipped:    'Trim found nothing to remove on {count} images.',

    // --- Adjust panel -----------------------------------------------------
    adjustBrightness:         'Brightness',
    adjustContrast:           'Contrast',
    adjustSaturation:         'Saturation',
    adjustBlur:               'Blur',
    adjustResetAll:           'Reset all',
    adjustReset:              'Reset {label}',
    filterPresetLabel:        'Filter',
    filterPresetAria:         'Filter preset',
    filterPresetNone:         'None',
    filterPresetGrayscale:    'Grayscale',
    filterPresetSepia:        'Sepia',
    filterPresetInvert:       'Invert',

    // --- Overlays panel ---------------------------------------------------
    overlaysEmpty:            'No overlays yet. Use a tool to add one.',
    overlayDelete:            'Delete overlay',
    overlayDeleteShort:       'Delete',
    overlayLabelText:         'Text',
    overlayLabelBrush:        'Brush',
    overlayLabelShape:        'Shape',
    overlayLabelRedact:       'Redact',
    overlayEmptyText:         '(empty text)',

    // --- Export panel -----------------------------------------------------
    exportQuality:            'Quality',
    exportQualityAria:        'Export quality',
    exportFilename:           'Filename',
    exportFilenameAria:       'Filename template',
    exportFilenameHelp:       '{base} = original filename, {date} = today’s date',
    exportFormatAria:         'Export as {label}',
    exportDownload:           'Download',
    exportDownloadAria:       'Download exported image',
    exportOutput:             'Output: {w} × {h} px',
    exportOutputEmpty:        'Output: —',
    exportFormatPng:          'PNG',
    exportFormatJpg:          'JPG',
    exportFormatWebp:         'WebP',
    exportFormatPdf:          'PDF',
    exportFormatPdfAria:      'Export as PDF',
    exportPredictedSize:      'Predicted size: {size}',
    exportPredictedSizeBatch: '{count} images · est. {size} output',
    exportPredictedEstimating: 'Predicted size: estimating…',
    exportPredictedPdfNote:   'Predicted size: approximate for PDF',
    exportSmallestPreset:     'Smallest size',
    exportSmallestPresetAria: 'Find the format and quality that produces the smallest file size',
    exportSmallestWorking:    'Comparing formats…',
    exportSmallestToast:      'Smallest: {format} @ {quality}% ({size})',
    exportSmallestToastBatch: 'Smallest for first image: {format} @ {quality}%',
    exportSmallestNoSavings:  'PNG (lossless) is already smallest for this image.',

    // --- PDF export (v1.1 Feature 4) -------------------------------------
    // Page-size / orientation / margins / fit options surface in the Export
    // panel when the user picks the PDF format chip. Batch PDF produces a
    // single multi-page file (one image per page) — the headline differ-
    // entiator vs the "Export queue (ZIP)" path.
    pdfPageSize:              'Page size',
    pdfPageSizeAria:          'PDF page size',
    pdfPageFit:               'Fit to image',
    pdfPageLetter:            'Letter (8.5×11 in)',
    pdfPageA4:                'A4 (210×297 mm)',
    pdfPageLegal:             'Legal (8.5×14 in)',
    pdfPageA3:                'A3 (297×420 mm)',
    pdfPageB5:                'B5 (176×250 mm)',
    pdfOrientation:           'Orientation',
    pdfOrientationAria:       'PDF page orientation',
    pdfOrientationAuto:       'Auto',
    pdfOrientationPortrait:   'Portrait',
    pdfOrientationLandscape:  'Landscape',
    pdfMargins:               'Margins (pt)',
    pdfMarginsAria:           'PDF page margins in points',
    pdfFitMode:               'Fit mode',
    pdfFitModeAria:           'PDF image fit mode',
    pdfFitContain:            'Contain (fit inside)',
    pdfFitCover:              'Cover (fill, may crop)',
    batchExportPdf:           'Export queue (single PDF)',
    batchExportPdfAria:       'Export the entire queue as a single multi-page PDF',
    pdfExportSuccess:         'Exported {filename} ({size})',
    pdfBatchSuccess:          'Exported {count}-page PDF ({size})',

    // --- EXIF / GPS strip disclosure (v1.1) ------------------------------
    // Shown in the Export panel as an always-on privacy guarantee — every
    // export is re-encoded through Canvas, which drops EXIF/XMP/GPS as a
    // side-effect. The Verify button inspects the last exported blob's
    // bytes so the guarantee is observable, not merely asserted.
    exifStripped:             'Metadata stripped on export',
    exifVerify:               'Verify last export',
    exifVerifyNoExport:       'Export a file first, then verify.',
    exifVerifyClean:          'No EXIF, XMP, or GPS data found in the last exported file.',
    exifVerifyFound:          'Found metadata: {tags}',
    exifTooltip:              'Every export is re-encoded through HTML Canvas, which produces a clean output without EXIF, XMP, or GPS metadata from the original.',

    // --- Crop tool --------------------------------------------------------
    cropTitle:                'Crop',
    cropAspectLock:           'Aspect lock',
    cropAspectLockAria:       'Aspect lock',
    cropAspectFree:           'Free',
    cropAspect11:             '1:1',
    cropAspect43:             '4:3',
    cropAspect169:            '16:9',
    cropAspect32:             '3:2',
    cropAspectCustom:         'Custom',
    cropCustomLabel:          'W:H',
    cropCustomPlaceholder:    'e.g. 4:3 or 1.5',
    cropCustomAria:           'Custom aspect ratio',
    cropApply:                'Apply',
    cropCancel:               'Cancel',

    // --- Select / transform tool ------------------------------------------
    selectTransform:          'Transform',
    selectRotateMinus90:      'Rotate -90 degrees',
    selectRotatePlus90:       'Rotate +90 degrees',
    selectRotateMinus90Short: 'Rotate -90°',
    selectRotatePlus90Short:  'Rotate +90°',
    selectRotateMinus90Label: '↶ -90°',
    selectRotatePlus90Label:  '+90° ↷',
    selectRotateSliderAria:   'Rotation degrees',
    selectRotateReadout:      'Rotation: {deg}°',
    selectFlip:               'Flip',
    selectFlipH:              'Flip horizontal',
    selectFlipV:              'Flip vertical',

    // --- Text tool --------------------------------------------------------
    textTitle:                'Text',
    textEmpty:                'Click anywhere to add text.',
    textLabel:                'Text',
    textAria:                 'Overlay text',
    textFont:                 'Font',
    textFontAria:             'Font family',
    textFontOnest:            'Onest',
    textFontSystem:           'System UI',
    textSize:                 'Size',
    textSizeAria:             'Font size in pixels',
    textWeight:               'Weight',
    textWeightAria:           'Font weight',
    textColor:                'Color',
    textColorAria:            'Text color',
    textAlign:                'Align',
    textAlignLeft:            'Left',
    textAlignCenter:          'Center',
    textAlignRight:           'Right',
    textAlignAria:            'Align {label}',
    textDelete:               'Delete this text',

    // --- Brush tool -------------------------------------------------------
    brushTitle:               'Brush',
    brushColor:               'Color',
    brushColorAria:           'Brush color',
    brushSize:                'Size',
    brushSizeAria:            'Brush size',
    brushPreview:             'Preview',
    brushPreviewAria:         'Brush preview',
    brushHint:                'Click and drag to draw.',

    // --- Shape tool -------------------------------------------------------
    shapeTitle:               'Shape',
    shapeKind:                'Kind',
    shapeKindLine:            'Line',
    shapeKindRect:            'Rect',
    shapeKindArrow:           'Arrow',
    shapeKindCircle:          'Circle',
    shapeKindAria:            'Shape: {label}',
    shapeStroke:              'Stroke',
    shapeStrokeAria:          'Stroke color',
    shapeFill:                'Fill',
    shapeFillToggleAria:      'Use fill color',
    shapeFillAria:            'Fill color',
    shapeWidth:               'Width',
    shapeStrokeWidthAria:     'Stroke width',
    shapeHint:                'Drag from one corner to the other.',

    // --- Redact tool ------------------------------------------------------
    redactTitle:              'Redact',
    redactMode:               'Mode',
    redactModePixelate:       'Pixelate',
    redactModeBlur:           'Blur',
    redactStrength:           'Strength',
    redactStrengthAria:       'Redact strength',
    redactApply:              'Apply',
    redactHint:               'Drag a region to redact. Adjust strength below. Apply to finish.',

    // --- Eyedropper / color-to-transparent tool ---------------------------
    eyedropperTitle:          'Color to transparent',
    eyedropperSwatchAria:     'Sampled color',
    eyedropperHexPlaceholder: '#RRGGBB',
    eyedropperHexAria:        'Hex color',
    eyedropperTolerance:      'Tolerance',
    eyedropperToleranceAria:  'Color match tolerance',
    eyedropperApply:          'Apply',
    eyedropperCancel:         'Cancel',
    eyedropperClickHint:      'Click on the image to sample.',

    // --- Background-remove tool -------------------------------------------
    bgRemoveTitle:            'Remove background',
    bgRemoveHelpPreConsent:   'Uses an open-source AI model that runs on your device. First use downloads the model.',
    bgRemoveHelpPostConsent:  'Runs the AI model locally on this device. Press Apply to start.',
    bgRemoveApply:            'Apply',
    bgRemoveRemoving:         'Removing…',
    bgRemoveRunAgain:         'Run again',
    bgRemoveStatusNoImage:    'No image selected.',
    bgRemoveStatusProcessing: 'Processing — this can take a few seconds.',
    bgRemoveStatusDone:       'Background removed.',
    bgRemoveStatusIdle:       'Click Apply to run AI background removal on this image.',
    bgRemoveLoadingModel:     'Loading model…',
    bgRemoveProgressStage:    '{stage}: {percent}%',
    bgRemoveUndoHint:         'Use Ctrl+Z (Cmd+Z) to revert.',
    // Canvas-overlay progress card (shown over the image while bg-remove runs).
    bgRemoveOverlayTitle:        'Removing background…',
    bgRemoveStageLoadingModel:   'Loading model',
    bgRemoveStageFetchingChunks: 'Fetching model files',
    bgRemoveStageDecode:         'Decoding image',
    bgRemoveStageInference:      'Running inference',
    bgRemoveStageMask:           'Building mask',
    bgRemoveStageEncode:         'Finalizing',
    bgRemoveDone:             'Background removed.',
    bgRemoveConsentLabel:     'Background removal consent',
    bgRemoveConsentTitle:     'Remove background',
    bgRemoveConsentBody:      'This feature runs an open-source AI model entirely on your device. The model files ({size}) load from this site on first use and are cached after, so subsequent uses are quick.',
    bgRemoveConsentReassure:  'Your image files still never leave your browser.',
    bgRemoveConsentLicense:   "The model is open source under AGPL-3.0; the project's <a href=\"/privacy.html\">privacy page</a> links to the source.",
    bgRemoveConsentContinue:  'Continue',
    bgRemoveConsentCancel:    'Cancel',
    bgRemoveConfirmFallback:  'Remove background uses an open-source AI model (~110 MB on first use). Continue?',
    bgRemoveErrLoad:          'Background-removal model is not installed on this server. Please contact the operator.',
    bgRemoveErrDecode:        'Failed to decode the model output. See console for details.',
    bgRemoveErrRun:           'Background removal failed for this image. See console for details.',
    bgRemoveErrGeneric:       'Background removal failed. See console for details.',

    // --- Importer ---------------------------------------------------------
    importerRejectedType:     'Cannot import files of type "{type}". Supported: JPEG, PNG, WebP, GIF.',
    importerDecodeFailed:     'Failed to decode "{name}".',
    importerThumbFailed:      'Failed to generate thumbnail for "{name}".',
    importerOversizeTitle:    'Image too large for this device',
    importerOversizeBody:     'The image {filename} is {width}×{height}px. This device supports images up to {max}×{max}px. Downscale to fit, or skip?',
    importerOversizeDownscale: 'Downscale',
    importerOversizeSkip:     'Skip',

    // --- Toast messages ---------------------------------------------------
    toastDismiss:             'Dismiss',
    toastWebpUnsupported:     'WebP not supported on this browser — falling back to PNG for batch.',
    toastBootFailed:          'Failed to start the editor.',

    // --- Settings popover (Phase 12B) -------------------------------------
    // Theme labels (auto / light / dark), option lists, control labels, plus
    // the "Restore default settings" button. The popover's a11y label is
    // already covered by the topbar `settings` key.
    settingsTheme:            'Theme',
    settingsThemeAria:        'Theme',
    settingsThemeAuto:        'Auto',
    settingsThemeLight:       'Light',
    settingsThemeDark:        'Dark',
    settingsDefaultFormat:    'Default export format',
    settingsDefaultFormatAria: 'Default export format',
    settingsDefaultQuality:   'Default JPG/WebP quality',
    settingsDefaultQualityAria: 'Default JPG and WebP export quality',
    settingsConfirmRemove:    'Confirm before removing from queue',
    settingsConfirmRemoveAria: 'Confirm before removing an image from the queue',
    settingsConfirmRemovePrompt: 'Remove {name} from queue?',
    settingsOverlayOutlines:  'Show overlay outlines',
    settingsOverlayOutlinesAria: 'Show outlines around every overlay',
    settingsSmoothBrush:      'Smooth brush strokes',
    settingsSmoothBrushAria:  'Smooth brush strokes with Catmull-Rom resampling',
    settingsAutoRefreshThumbs:    'Auto-refresh thumbnails after batch operations',
    settingsAutoRefreshThumbsAria: 'Auto-refresh thumbnails after batch operations',
    settingsShowTheme:        'Show light/dark toggle button',
    settingsShowThemeAria:    'Show the topbar light/dark toggle button',
    settingsShowLanguage:     'Show language selector',
    settingsShowLanguageAria: 'Show the topbar language selector button',
    settingsRestoreDefaults:  'Restore default settings',
    settingsRestoreDefaultsAria: 'Restore default settings',

    // --- Privacy panel modal (Phase 12B) ----------------------------------
    // These keys MAY CONTAIN HTML (rendered via innerHTML inside the prose
    // article). All anchor hrefs are static and trusted; we don't pass any
    // user-derived content into these strings, so the innerHTML use is safe.
    // The list-item bodies live in a single key each (privacyFetchesList,
    // privacyNotList, privacyExternalList) so a translator can render the
    // whole <li>…</li> block per locale without us splitting them apart.
    close:                    'Close',
    privacyTitle:             'Privacy',
    privacyLead:              'NoAdsPhotos processes images entirely in your browser. Image files never leave your device — there is no upload, no server-side rendering, and no cloud round-trip.',
    privacyFetchesHeading:    'What this site fetches (from this origin only)',
    privacyFetchesList:       '<li>HTML, CSS, JavaScript, and self-hosted Onest fonts.</li><li>The JSZip library (~97&nbsp;KB) — ONLY when you click "Export queue (ZIP)" for the first time. Vendored from <a href="https://stuk.github.io/jszip/" target="_blank" rel="noopener">stuk.github.io/jszip</a>, served from this origin. Used to package your batch exports into a single ZIP locally — no network traffic.</li><li>The jsPDF library (~420&nbsp;KB) — ONLY when you click PDF export for the first time. Vendored from <a href="https://github.com/parallax/jsPDF" target="_blank" rel="noopener">github.com/parallax/jsPDF</a> (npm), served from this origin. Used to build PDF files from your images locally — no network traffic.</li><li>Self-hosted ML model files for background removal (the <a href="https://github.com/imgly/background-removal-js" target="_blank" rel="noopener">@imgly/background-removal</a> ISNET fp16 model + <a href="https://github.com/microsoft/onnxruntime" target="_blank" rel="noopener">ONNX Runtime Web</a> WASM kernels — both the CPU SIMD path and the WebGPU/JSEP path so the model can run on the GPU when available). These files (~118&nbsp;MB total) are part of the site code, shipped from this repository — they are NOT a separate first-use download from a third party. Your browser fetches them only the first time you click "Remove background", from this origin, and caches them thereafter. The browser pulls only the kernels it actually needs — CPU-only browsers never download the WebGPU variant, and vice versa.</li><li>The favicon and logo SVG.</li>',
    privacyNotHeading:        'What this site does NOT do',
    privacyNotList:           '<li>No third-party CDNs (no Google Fonts, no jsDelivr, no cdnjs, no Cloudflare-served libraries).</li><li>No analytics or telemetry (no Google Analytics, Plausible, Fathom, Mixpanel, gtag, fbq, or similar).</li><li>No cookies. No fingerprinting. No localStorage data shared off-device.</li><li>No upload of your images, masks, or edits. No "save to cloud" feature exists.</li>',
    privacyExternalHeading:   'External links that open on click',
    privacyExternalList:      '<li>GitHub source repository — only if you click the "Source" link in the footer.</li><li>Ko-fi tip page — only if you click "Tip".</li><li>Nothing else; verify in DevTools &rarr; Network.</li>',
    privacyStorageHeading:    'Local storage',
    privacyStorageBody:       'Your preferences (language, theme, tool settings, default export format) are saved in your browser\'s localStorage. You can clear them anytime via your browser\'s site-data tools.',
    privacyAIHeading:         'AI translations',
    privacyAIBody:            'The UI is translated into 15 languages with the help of AI tools. Errors may exist; report them in the GitHub issue tracker.',
    privacyOpenSourceHeading: 'Open source',
    privacyOpenSourceBody:    'Licensed under GNU AGPL v3.0. Source repository: <a href="https://github.com/Dan512/noadsphotos" target="_blank" rel="noopener">https://github.com/Dan512/noadsphotos</a>.',
    privacyTipHeading:        'Support this site',
    privacyTipBody:           'If this is useful, <a href="https://ko-fi.com/noadsdude" target="_blank" rel="noopener">tip via Ko-fi</a>.',
    privacyStaticLink:        'Open this notice as a standalone page',

    // --- Exporter ---------------------------------------------------------
    exportNoImage:            'No image to export.',
    exportNotReady:           'Export not ready. Please refresh and try again.',
    exportDownloadFailedSingle: 'Export ready but download failed to start. See console.',
    exportSuccessWithSize:    'Exported {filename} ({size})',
    exportQueueEmpty:         'Nothing to export — the queue is empty.',
    exportZipLibFailed:       'Failed to load ZIP library. Check your network or refresh.',
    exportCancelled:          'Export cancelled.',
    exportNothingSucceeded:   'No images were exported. See per-image errors in the progress dialog (already closed).',
    exportZipBuildFailed:     'Failed to build ZIP archive.',
    exportZipDownloadFailed:  'ZIP ready but download failed to start. See console.',
    exportBatchPartial:       'Exported {count} images ({failed} failed).',
    exportBatchDoneWithSize:  'Exported {count} images, {size} ZIP',
    exportBatchEachDoneWithSize: 'Exported {count} files, {size} total',
    exportNoCtxFilter:        'This browser lacks ctx.filter support; blur will not be baked into the export.',
    exportRedactNote:         'Redact regions export as a placeholder in v1. Full blur/pixelate bake is a v2 follow-up.',
    exportUnsupportedFormat:  "This browser doesn't support {format}. Try PNG or JPEG.",
    exportTooLarge:           'Output image too large for this device. Use a smaller resize.',
    exportSourceMissing:      'Source image unavailable. Re-import and try again.',
    exportGenericFailed:      'Export failed. See console for details.',
  },

  // The other languages are intentionally empty for v1 — missing keys fall
  // back to en. AI-translated copy lands here in a follow-up pass (Phase 14
  // polish or v1.1).
  // es: Stub. AI-translated copy lands here in v1.1. Missing keys fall back to en.
  es: {},
  // de: Stub. AI-translated copy lands here in v1.1. Missing keys fall back to en.
  de: {},
  // fr: Stub. AI-translated copy lands here in v1.1. Missing keys fall back to en.
  fr: {},
  // it: Stub. AI-translated copy lands here in v1.1. Missing keys fall back to en.
  it: {},
  // pt: Stub. AI-translated copy lands here in v1.1. Missing keys fall back to en.
  pt: {},
  // nl: Stub. AI-translated copy lands here in v1.1. Missing keys fall back to en.
  nl: {},
  // pl: Stub. AI-translated copy lands here in v1.1. Missing keys fall back to en.
  pl: {},
  // ja: Stub. AI-translated copy lands here in v1.1. Missing keys fall back to en.
  ja: {},
  // zh-CN: Stub. AI-translated copy lands here in v1.1. Missing keys fall back to en.
  'zh-CN': {},
  // ko: Stub. AI-translated copy lands here in v1.1. Missing keys fall back to en.
  ko: {},
  // ru: Stub. AI-translated copy lands here in v1.1. Missing keys fall back to en.
  ru: {},
  // ar: Stub. AI-translated copy lands here in v1.1. Missing keys fall back to en.
  ar: {},
  // hi: Stub. AI-translated copy lands here in v1.1. Missing keys fall back to en.
  hi: {},
  // tr: Stub. AI-translated copy lands here in v1.1. Missing keys fall back to en.
  tr: {},
};

let active = 'en';

// Map navigator.language to one of our LANGS. Handles common 2-letter
// prefixes (en-US → en, fr-CA → fr) and routes any zh-* (zh-CN, zh-TW,
// zh-Hant, …) to the v1 'zh-CN' bucket.
export function detectLanguage() {
  const raw = (typeof navigator !== 'undefined' && navigator.language
    ? navigator.language
    : 'en'
  ).toLowerCase();
  if (raw.startsWith('zh')) return 'zh-CN';
  const short = raw.split('-')[0];
  return LANGS.find(l => l === short) || 'en';
}

export function setLanguage(code) {
  active = pickFromAllowlist(code, LANGS, 'en');
  try {
    localStorage.setItem('noadsimages_lang', active);
  } catch { /* ignore — Safari private mode etc. */ }
  if (typeof document !== 'undefined' && document.documentElement) {
    document.documentElement.lang = active;
    document.documentElement.dir = RTL_LANGS.has(active) ? 'rtl' : 'ltr';
  }
  applyDomTranslations();
}

export function getLanguage() {
  return active;
}

// Look up a key in the active dict, falling back to EN, falling back to
// `[?]key`. Variable substitution uses {name} placeholders; values are
// HTML-escaped so the result stays safe to assign to innerHTML.
export function t(key, vars) {
  const dict = TRANSLATIONS[active] || TRANSLATIONS.en;
  const raw = dict[key] ?? TRANSLATIONS.en[key];
  if (raw === undefined) {
    // Dev hint: prefix missing keys with [?] so they're visually obvious
    // during development. Production: same — better than crashing.
    return `[?]${key}`;
  }
  if (!vars) return raw;
  return raw.replace(/\{(\w+)\}/g, (_, k) => {
    const v = vars[k];
    return v === undefined || v === null ? '' : escapeHtml(v);
  });
}

// Walk the static DOM and apply translations. Elements with [data-i18n]
// have their textContent replaced; elements with [data-i18n-attr] have
// that attribute set instead.
export function applyDomTranslations() {
  if (typeof document === 'undefined' || !document.querySelectorAll) return;
  for (const el of document.querySelectorAll('[data-i18n]')) {
    const key = el.dataset.i18n;
    if (!key) continue;
    const attr = el.dataset.i18nAttr;
    if (attr) {
      el.setAttribute(attr, t(key));
    } else {
      el.textContent = t(key);
    }
  }
}

// Boot helper: read stored preference, fall back to navigator detection,
// then apply.
export function initI18n() {
  let stored = null;
  try {
    stored = localStorage.getItem('noadsimages_lang');
  } catch { /* ignore */ }
  const initial = pickFromAllowlist(stored, LANGS, null) ?? detectLanguage();
  setLanguage(initial);
}
