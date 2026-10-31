/* SPDX-License-Identifier: GPL-2.0-or-later */
#pragma once

#include <gio/gio.h>
#include <meta/meta-selection-source.h>

G_BEGIN_DECLS

#define CLIP_SHELF_TYPE_SELECTION_SOURCE (clip_shelf_selection_source_get_type ())
G_DECLARE_FINAL_TYPE (ClipShelfSelectionSource, clip_shelf_selection_source,
                      CLIP_SHELF, SELECTION_SOURCE, MetaSelectionSource)

/**
 * clip_shelf_selection_source_new:
 *
 * Creates an independent clipboard owner capable of advertising all stored
 * representations at once. Populate it before calling meta_selection_set_owner().
 *
 * Returns: (transfer full): a clipboard source
 */
ClipShelfSelectionSource *clip_shelf_selection_source_new (void);

/**
 * clip_shelf_selection_source_add:
 * @self: the clipboard source
 * @mimetype: a clipboard MIME type
 * @bytes: exact bytes for this representation
 *
 * Adds a representation. All data is retained by reference, without file I/O.
 */
void clip_shelf_selection_source_add (ClipShelfSelectionSource *self,
                                      const char               *mimetype,
                                      GBytes                   *bytes);

G_END_DECLS
