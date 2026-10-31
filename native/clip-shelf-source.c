/* SPDX-License-Identifier: GPL-2.0-or-later */
#include "clip-shelf-source.h"

struct _ClipShelfSelectionSource
{
  MetaSelectionSource parent_instance;
  GHashTable *representations;
};

G_DEFINE_TYPE (ClipShelfSelectionSource, clip_shelf_selection_source,
               META_TYPE_SELECTION_SOURCE)

static GList *
clip_shelf_selection_source_get_mimetypes (MetaSelectionSource *source)
{
  ClipShelfSelectionSource *self = CLIP_SHELF_SELECTION_SOURCE (source);
  GList *types = NULL;
  GHashTableIter iter;
  gpointer key;

  g_hash_table_iter_init (&iter, self->representations);
  while (g_hash_table_iter_next (&iter, &key, NULL))
    types = g_list_prepend (types, g_strdup (key));
  return g_list_reverse (types);
}

static void
clip_shelf_selection_source_read_async (MetaSelectionSource *source,
                                         const char          *mimetype,
                                         GCancellable        *cancellable,
                                         GAsyncReadyCallback  callback,
                                         gpointer             user_data)
{
  ClipShelfSelectionSource *self = CLIP_SHELF_SELECTION_SOURCE (source);
  GBytes *bytes = g_hash_table_lookup (self->representations, mimetype);
  g_autoptr (GTask) task = g_task_new (source, cancellable, callback, user_data);

  g_task_set_source_tag (task, clip_shelf_selection_source_read_async);
  if (g_task_return_error_if_cancelled (task))
    return;
  if (bytes == NULL)
    {
      g_task_return_new_error (task, G_IO_ERROR, G_IO_ERROR_NOT_SUPPORTED,
                               "Clipboard format is unavailable");
      return;
    }
  /* A new stream per request also supports concurrent consumers. */
  g_task_return_pointer (task, g_memory_input_stream_new_from_bytes (bytes),
                         g_object_unref);
}

static GInputStream *
clip_shelf_selection_source_read_finish (MetaSelectionSource *source,
                                          GAsyncResult        *result,
                                          GError             **error)
{
  g_return_val_if_fail (g_task_is_valid (result, source), NULL);
  return g_task_propagate_pointer (G_TASK (result), error);
}

static void
clip_shelf_selection_source_finalize (GObject *object)
{
  ClipShelfSelectionSource *self = CLIP_SHELF_SELECTION_SOURCE (object);
  g_clear_pointer (&self->representations, g_hash_table_unref);
  G_OBJECT_CLASS (clip_shelf_selection_source_parent_class)->finalize (object);
}

static void
clip_shelf_selection_source_class_init (ClipShelfSelectionSourceClass *klass)
{
  MetaSelectionSourceClass *source_class = META_SELECTION_SOURCE_CLASS (klass);
  G_OBJECT_CLASS (klass)->finalize = clip_shelf_selection_source_finalize;
  source_class->get_mimetypes = clip_shelf_selection_source_get_mimetypes;
  source_class->read_async = clip_shelf_selection_source_read_async;
  source_class->read_finish = clip_shelf_selection_source_read_finish;
}

static void
clip_shelf_selection_source_init (ClipShelfSelectionSource *self)
{
  self->representations = g_hash_table_new_full (g_str_hash, g_str_equal, g_free,
                                                (GDestroyNotify) g_bytes_unref);
}

ClipShelfSelectionSource *
clip_shelf_selection_source_new (void)
{
  return g_object_new (CLIP_SHELF_TYPE_SELECTION_SOURCE, NULL);
}

void
clip_shelf_selection_source_add (ClipShelfSelectionSource *self,
                                  const char               *mimetype,
                                  GBytes                   *bytes)
{
  g_return_if_fail (CLIP_SHELF_IS_SELECTION_SOURCE (self));
  g_return_if_fail (mimetype != NULL && *mimetype != '\0');
  g_return_if_fail (bytes != NULL);
  g_hash_table_replace (self->representations, g_strdup (mimetype),
                        g_bytes_ref (bytes));
}
