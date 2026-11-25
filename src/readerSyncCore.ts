import { createHash } from "crypto";
import type { BookSyncSnapshot } from "./bookUtil";

export interface LocalProgress {
  bookId: string;
  locator: string;
  percentage: number;
  chapterTitle: string;
}

const CHAPTER_PATTERNS: RegExp[] = [
  /^\s*第\s*[0-9零一二三四五六七八九十百千万两]+\s*[章回节卷篇集]\s*.{0,60}$/,
  /^\s*(?:序章|序言|楔子|引子|前言|后记|尾声|终章|番外|附录)\s*.{0,40}$/,
  /^\s*Chapter\s*\d+.*$/i,
  /^\s*#{1,3}\s+.+$/,
];

function clampPercentage(value: number): number {
  return Math.min(1, Math.max(0, Number.isFinite(value) ? value : 0));
}

interface ChapterCoordinate {
  title: string;
  readerLength: number;
  displayLength: number;
}

interface CoordinateMap {
  chapters: ChapterCoordinate[];
  prefaceDisplayLength: number;
  totalReaderLength: number;
}

function displayText(text: string, lineBreak: string): string {
  return text
    .replace(/\n/g, lineBreak)
    .replace(/\r/g, " ")
    .replace(/　　/g, " ")
    .replace(/ /g, " ");
}

function coordinateMap(snapshot: BookSyncSnapshot): CoordinateMap {
  const lines = snapshot.rawText.split(/\r\n|\r|\n/);
  const lineStarts = [0];
  const newline = /\r\n|\r|\n/g;
  let match: RegExpExecArray | null;
  while ((match = newline.exec(snapshot.rawText)) !== null) {
    lineStarts.push(match.index + match[0].length);
  }
  const headings: Array<{ title: string; startLine: number }> = [];

  for (let index = 0; index < lines.length; index += 1) {
    const title = lines[index].trim();
    if (
      title.length > 0 &&
      title.length <= 60 &&
      CHAPTER_PATTERNS.some((pattern) => pattern.test(title))
    ) {
      headings.push({ title, startLine: index });
    }
  }

  if (headings.length === 0) {
    return { chapters: [], prefaceDisplayLength: 0, totalReaderLength: 0 };
  }

  const firstChapterStart = lineStarts[headings[0].startLine] ?? 0;
  const chapters = headings.map((heading, index) => {
    const next = headings[index + 1];
    const endLine = next ? next.startLine : lines.length;
    const rawStart = lineStarts[heading.startLine] ?? 0;
    const rawEnd = next ? (lineStarts[next.startLine] ?? snapshot.rawText.length) : snapshot.rawText.length;
    const readerLength = Math.max(200, lines.slice(heading.startLine, endLine).join("\n").length);
    return {
      title: heading.title,
      readerLength,
      displayLength: displayText(snapshot.rawText.slice(rawStart, rawEnd), snapshot.lineBreak).length,
    };
  });
  return {
    chapters,
    prefaceDisplayLength: displayText(snapshot.rawText.slice(0, firstChapterStart), snapshot.lineBreak).length,
    totalReaderLength: chapters.reduce((sum, chapter) => sum + chapter.readerLength, 0),
  };
}

export function computeReaderBookId(bytes: Buffer): string {
  const contentHash = createHash("sha256").update(bytes).digest("hex");
  return createHash("sha256").update(`\u0000${contentHash}`).digest("hex");
}

export function createLocalProgress(snapshot: BookSyncSnapshot): LocalProgress {
  const bookId = computeReaderBookId(snapshot.bytes);
  const map = coordinateMap(snapshot);
  const displayOffset = Math.min(
    Math.max(0, (Math.max(1, snapshot.currentPage) - 1) * snapshot.pageSize),
    snapshot.textLength,
  );

  if (map.chapters.length === 0) {
    const percentage = clampPercentage(displayOffset / Math.max(1, snapshot.textLength));
    return { bookId, locator: "", percentage, chapterTitle: "" };
  }

  let consumedDisplay = map.prefaceDisplayLength;
  let consumedReader = 0;
  let chapterIndex = map.chapters.length - 1;
  for (let index = 0; index < map.chapters.length; index += 1) {
    const chapter = map.chapters[index];
    if (displayOffset < consumedDisplay + chapter.displayLength || index === map.chapters.length - 1) {
      chapterIndex = index;
      break;
    }
    consumedDisplay += chapter.displayLength;
    consumedReader += chapter.readerLength;
  }

  const chapter = map.chapters[chapterIndex];
  const within = clampPercentage((displayOffset - consumedDisplay) / Math.max(1, chapter.displayLength));
  const percentage = clampPercentage(
    (consumedReader + chapter.readerLength * within) / Math.max(1, map.totalReaderLength),
  );
  return {
    bookId,
    locator: `r1:${within.toFixed(4)}:chapter:${chapterIndex}`,
    percentage,
    chapterTitle: chapter.title,
  };
}

export function pageForReaderPercentage(snapshot: BookSyncSnapshot, percentage: number): number {
  const map = coordinateMap(snapshot);
  const safePercentage = clampPercentage(percentage);
  if (map.chapters.length === 0) {
    return Math.min(
      Math.max(1, Math.floor((safePercentage * snapshot.textLength) / snapshot.pageSize) + 1),
      Math.max(1, snapshot.totalPages),
    );
  }

  const target = safePercentage * map.totalReaderLength;
  let consumedReader = 0;
  let displayOffset = map.prefaceDisplayLength;
  for (let index = 0; index < map.chapters.length; index += 1) {
    const chapter = map.chapters[index];
    if (target < consumedReader + chapter.readerLength || index === map.chapters.length - 1) {
      const within = clampPercentage((target - consumedReader) / chapter.readerLength);
      displayOffset += chapter.displayLength * within;
      break;
    }
    consumedReader += chapter.readerLength;
    displayOffset += chapter.displayLength;
  }

  return Math.min(
    Math.max(1, Math.floor((displayOffset + 1e-7) / snapshot.pageSize) + 1),
    Math.max(1, snapshot.totalPages),
  );
}
