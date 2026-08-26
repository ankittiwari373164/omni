// lib/cleanup.js
// ============================================================================
// Delete old uploaded videos from Supabase Storage + database to save space.
// Keeps videos for N days (default 7), then deletes them.
// ============================================================================

const KEEP_DAYS = parseInt(process.env.CLEANUP_KEEP_DAYS || "7", 10);

async function cleanupOldVideos({ supabase, log = () => {} }) {
  const result = { deleted: 0, freed_mb: 0, errors: 0 };
  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - KEEP_DAYS);
  const cutoffISO = cutoffDate.toISOString();

  try {
    log("info", `🧹 Cleanup: finding videos older than ${KEEP_DAYS} days (before ${cutoffISO.slice(0, 10)})`);

    // Get old uploaded videos
    const { data: oldVideos, error: fetchErr } = await supabase
      .from("videos")
      .select("id, storage_path, video_file_size")
      .eq("status", "uploaded")
      .lt("created_at", cutoffISO);

    if (fetchErr) {
      log("error", `Cleanup fetch failed: ${fetchErr.message}`);
      result.errors++;
      return result;
    }

    if (!oldVideos || oldVideos.length === 0) {
      log("info", "🧹 Cleanup: no old videos to delete");
      return result;
    }

    log("info", `🧹 Cleanup: found ${oldVideos.length} videos to delete`);

    // Delete from Storage
    for (const video of oldVideos) {
      try {
        if (video.storage_path) {
          const { error: delErr } = await supabase.storage
            .from("videos")
            .remove([video.storage_path]);
          if (delErr && !/not.found/i.test(delErr.message)) {
            log("warn", `could not delete ${video.storage_path}: ${delErr.message}`);
            result.errors++;
          } else {
            result.deleted++;
            if (video.video_file_size) result.freed_mb += video.video_file_size / (1024 * 1024);
          }
        }
      } catch (e) {
        log("warn", `storage delete failed for ${video.id}: ${e.message}`);
        result.errors++;
      }
    }

    // Delete from database
    const videoIds = oldVideos.map(v => v.id);
    const { error: dbErr } = await supabase
      .from("videos")
      .delete()
      .in("id", videoIds);

    if (dbErr) {
      log("error", `Cleanup database delete failed: ${dbErr.message}`);
      result.errors++;
    } else {
      log("success", `🧹 Cleanup: deleted ${result.deleted} videos, freed ${Math.round(result.freed_mb)} MB`);
    }
  } catch (e) {
    log("error", `Cleanup failed: ${e.message}`);
    result.errors++;
  }

  return result;
}

module.exports = { cleanupOldVideos };
