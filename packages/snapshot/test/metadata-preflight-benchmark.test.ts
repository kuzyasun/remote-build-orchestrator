import { execFile } from 'node:child_process';
import { mkdtemp, rm, statfs, writeFile } from 'node:fs/promises';
import { arch, platform, release, tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { writeZstdTarArchiveCandidate } from '../src/archive.js';
import {
  type CapturedFile,
  type MetadataPreflightExperimentWorkerCount,
  captureMetadataPreflightEntry,
  metadataPreflightExperimentWorkerCounts,
  runMetadataPreflightExperiment,
} from '../src/metadata-preflight.js';

const SAMPLE_COUNT = 5;
const FIXTURE_FILE_COUNT = 600;
const RSS_SAMPLING_INTERVAL_MS = 10;
const execFileAsync = promisify(execFile);
const benchmarkSourcePolicy = {
  include_untracked: false,
  include_ignored: [],
  secret_policy: 'allow' as const,
};
const LINUX_FILESYSTEM_TYPES: Record<number, string> = {
  16914836: 'tmpfs',
  1481003842: 'xfs',
  2035054128: 'overlayfs',
  61267: 'ext2/ext3/ext4',
  2435016766: 'btrfs',
};

function percentile(values: number[], percentileValue: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * percentileValue) - 1)] ?? 0;
}

async function measureMetadataPreflight(
  repoRoot: string,
  wirePaths: string[],
  workerCount: MetadataPreflightExperimentWorkerCount,
): Promise<{
  elapsedMs: number;
  initialRssBytes: number;
  metadata: CapturedFile[];
  observedPeakRssBytes: number;
}> {
  const initialRss = process.memoryUsage().rss;
  let peakRss = initialRss;
  const sampleRss = () => {
    peakRss = Math.max(peakRss, process.memoryUsage().rss);
  };
  const sampler = setInterval(sampleRss, RSS_SAMPLING_INTERVAL_MS);
  sampler.unref();
  const started = performance.now();
  const stageModes = new Map<string, string>();
  let metadata: CapturedFile[];
  let elapsedMs: number;
  try {
    metadata = await runMetadataPreflightExperiment({
      items: wirePaths,
      workerCount,
      inspect: (wirePath) =>
        captureMetadataPreflightEntry(repoRoot, wirePath, stageModes, benchmarkSourcePolicy),
    });
    elapsedMs = Number((performance.now() - started).toFixed(3));
  } finally {
    clearInterval(sampler);
    sampleRss();
  }

  return {
    elapsedMs: elapsedMs as number,
    initialRssBytes: initialRss,
    metadata: metadata as CapturedFile[],
    observedPeakRssBytes: peakRss,
  };
}

async function describeFixtureFilesystem(path: string): Promise<{
  type_label: string | null;
  type_raw: string | null;
  verified: boolean;
}> {
  try {
    if (platform() === 'win32') {
      const { stdout } = await execFileAsync(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          '(Get-Volume -FilePath ([System.IO.Path]::GetTempPath())).FileSystem',
        ],
        { windowsHide: true },
      );
      const typeLabel = stdout.trim().toLowerCase();
      if (typeLabel) {
        return { type_label: typeLabel, type_raw: null, verified: true };
      }
    }
    const info = await statfs(path);
    const type = Number(info.type);
    const typeLabel = platform() === 'linux' ? (LINUX_FILESYSTEM_TYPES[type] ?? null) : null;
    return {
      type_label: typeLabel,
      type_raw: info.type.toString(),
      verified: typeLabel !== null,
    };
  } catch {
    return { type_label: null, type_raw: null, verified: false };
  }
}

describe('S-05 metadata-concurrency benchmark harness', () => {
  it('records raw 1/4/8-worker profiles without changing the sequential capture default', async () => {
    const fixture = await mkdtemp(join(tmpdir(), 'rbo-s05-many-small-files-'));
    const archiveDir = await mkdtemp(join(tmpdir(), 'rbo-s05-archives-'));
    try {
      const wirePaths = await Promise.all(
        Array.from({ length: FIXTURE_FILE_COUNT }, async (_, index) => {
          const wirePath = `file-${String(index).padStart(5, '0')}.txt`;
          await writeFile(join(fixture, wirePath), `small-metadata-fixture-${index}\n`);
          return wirePath;
        }),
      );
      const fixtureFilesystem = await describeFixtureFilesystem(fixture);
      const archiveHashes: string[] = [];

      for (const workerCount of metadataPreflightExperimentWorkerCounts) {
        const samplesMs: number[] = [];
        let metadata: CapturedFile[] = [];
        let peakRssObservation: Awaited<ReturnType<typeof measureMetadataPreflight>> | undefined;
        const warmup = await measureMetadataPreflight(fixture, wirePaths, workerCount);
        for (let sample = 0; sample < SAMPLE_COUNT; sample += 1) {
          const sample = await measureMetadataPreflight(fixture, wirePaths, workerCount);
          metadata = sample.metadata;
          samplesMs.push(sample.elapsedMs);
          if (
            !peakRssObservation ||
            sample.observedPeakRssBytes - sample.initialRssBytes >
              peakRssObservation.observedPeakRssBytes - peakRssObservation.initialRssBytes
          ) {
            peakRssObservation = sample;
          }
        }

        const archive = await writeZstdTarArchiveCandidate(
          join(archiveDir, `profile-${workerCount}.tar.zst`),
          metadata.map((captured) => captured.tarEntry),
        );
        archiveHashes.push(archive.sha256);
        await rm(archive.candidatePath, { force: true });

        console.log(
          JSON.stringify({
            scenario: 's05_metadata_preflight_many_small_files',
            metadata_workers: workerCount,
            sample_count: SAMPLE_COUNT,
            warmup_ms: warmup.elapsedMs,
            samples_ms: samplesMs,
            median_ms: percentile(samplesMs, 0.5),
            p95_ms: percentile(samplesMs, 0.95),
            initial_rss_bytes: peakRssObservation?.initialRssBytes,
            observed_peak_rss_bytes: peakRssObservation?.observedPeakRssBytes,
            observed_peak_rss_delta_bytes:
              peakRssObservation === undefined
                ? undefined
                : peakRssObservation.observedPeakRssBytes - peakRssObservation.initialRssBytes,
            rss_sampling_interval_ms: RSS_SAMPLING_INTERVAL_MS,
            rss_measurement_method: 'process.memoryUsage().rss sampled during metadata preflight',
            rss_measurement_limitations:
              'sampled Node process RSS, not isolated or OS-level peak RSS; short-lived peaks between 10 ms samples can be missed',
            rss_profile_comparability:
              'profiles share one Node process; RSS observations are not baseline-comparable across profiles',
            fixture_file_count: FIXTURE_FILE_COUNT,
            fixture_bytes: metadata.reduce(
              (total, captured) =>
                total + (captured.entry.type === 'file' ? captured.entry.size : 0),
              0,
            ),
            metadata_result_count: metadata.length,
            in_flight_work_limit: workerCount,
            archive_sha256: archive.sha256,
            payload_read_mode: 'sequential_archive_writer',
            capture_default: 'sequential',
            adoption_status: 'sequential_default_retained_pending_windows_ntfs_and_linux_evidence',
            fixture_filesystem: fixtureFilesystem,
            external_evidence: {
              windows_ntfs:
                platform() === 'win32' && fixtureFilesystem.type_label === 'ntfs'
                  ? 'local_profile_only_threshold_comparison_pending_linux'
                  : 'missing_or_unverified',
              linux: platform() === 'linux' ? 'local_profile_only' : 'missing_current_run',
              required_for_adoption:
                'independent Windows NTFS and Linux benchmark datasets meeting S-05 thresholds',
            },
            environment: {
              platform: platform(),
              release: release(),
              arch: arch(),
              node: process.version,
            },
          }),
        );
      }

      expect(new Set(archiveHashes).size).toBe(1);
    } finally {
      await rm(fixture, { recursive: true, force: true });
      await rm(archiveDir, { recursive: true, force: true });
    }
  }, 60_000);
});
