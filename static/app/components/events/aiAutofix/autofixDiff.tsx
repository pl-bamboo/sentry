import {Fragment, useMemo} from 'react';
import styled from '@emotion/styled';
import {type Change, diffWords} from 'diff';

import {space} from 'sentry/styles/space';

type AutofixDiffProps = {};

type DiffLine = {
  added: boolean;
  changes: Change[];
  lineNumber: number;
  removed: boolean;
};

const CODE_BEFORE = `# or alternatively: \`used_memory_rss\`?
memory_used = info.get("used_memory", 0)
# \`maxmemory\` might be 0 in development
memory_available = info.get("maxmemory", 0) or info["total_system_memory"]

return ServiceMemory(node_id, memory_used, memory_available)
`;

const CODE_AFTER = `# or alternatively: \`used_memory_rss\`?
memory_used = info.get("used_memory", 0)
# \`maxmemory\` might be 0 in development
memory_available = info.get("maxmemory", 0) or info.get("total_system_memory", 0)

return ServiceMemory(node_id, memory_used, memory_available)
`;

const LINE_NUMBER_START = 47;

const FILE_NAME = 'src/sentry/processing/backpressure/memory.py';

export function AutofixDiff({}: AutofixDiffProps) {
  const diffLines = useMemo(() => {
    const beforeLines = CODE_BEFORE.split('\n');
    const afterLines = CODE_AFTER.split('\n');

    const lines: DiffLine[] = [];

    for (let i = 0; i < Math.max(beforeLines.length, afterLines.length); i++) {
      const diff = diffWords(beforeLines[i] ?? '', afterLines[i] ?? '');
      const added = diff.some(change => change.added);
      const removed = diff.some(change => change.removed);
      const lineNumber = i + LINE_NUMBER_START;

      if (added && removed) {
        lines.push(
          {
            added: false,
            changes: diff.filter(change => !change.added),
            lineNumber,
            removed: true,
          },
          {
            added: true,
            changes: diff.filter(change => !change.removed),
            lineNumber,
            removed: false,
          }
        );
      } else {
        lines.push({
          added: false,
          removed: false,
          changes: diff,
          lineNumber,
        });
      }
    }
    return lines;
  }, []);

  return (
    <FileDiffWrapper>
      <FileName>{FILE_NAME}</FileName>
      <DiffContainer>
        {diffLines.map(({added, removed, lineNumber, changes}, index) => {
          return (
            <Fragment key={index}>
              <LineNumber added={added} removed={removed}>
                {!added ? lineNumber : ''}
              </LineNumber>
              <LineNumber added={added} removed={removed}>
                {!removed ? lineNumber : ''}
              </LineNumber>
              <DiffContent added={added} removed={removed}>
                {changes.map((change, i) => (
                  <CodeDiff key={i} added={change.added} removed={change.removed}>
                    {change.value}
                  </CodeDiff>
                ))}
              </DiffContent>
            </Fragment>
          );
        })}
      </DiffContainer>
    </FileDiffWrapper>
  );
}

const FileDiffWrapper = styled('div')`
  margin: 0 -${space(2)};
  font-family: ${p => p.theme.text.familyMono};
  font-size: ${p => p.theme.fontSizeSmall};
  line-height: 20px;
  vertical-align: middle;
`;

const FileName = styled('div')`
  padding: 0 ${space(2)} ${space(1)} ${space(2)};
`;

const DiffContainer = styled('div')`
  border-top: 1px solid ${p => p.theme.border};
  border-bottom: 1px solid ${p => p.theme.border};
  display: grid;
  grid-template-columns: auto auto 1fr;
`;

const LineNumber = styled('div')<{added: boolean; removed: boolean}>`
  display: flex;
  padding: ${space(0.25)} ${space(2)};
  user-select: none;

  background-color: ${p => p.theme.backgroundSecondary};
  color: ${p => p.theme.subText};

  ${p =>
    p.added && `background-color: ${p.theme.diff.added}; color: ${p.theme.textColor}`};
  ${p =>
    p.removed &&
    `background-color: ${p.theme.diff.removed}; color: ${p.theme.textColor}`};

  & + & {
    padding-left: 0;
  }
`;

const DiffContent = styled('div')<{added: boolean; removed: boolean}>`
  position: relative;
  padding-left: ${space(4)};

  ${p =>
    p.added && `background-color: ${p.theme.diff.addedRow}; color: ${p.theme.textColor}`};
  ${p =>
    p.removed &&
    `background-color: ${p.theme.diff.removedRow}; color: ${p.theme.textColor}`};

  &::before {
    content: ${p => (p.added ? "'+'" : p.removed ? "'-'" : "''")};
    position: absolute;
    top: 1px;
    left: ${space(1)};
  }
`;

const CodeDiff = styled('span')<{added?: boolean; removed?: boolean}>`
  vertical-align: middle;
  ${p => p.added && `background-color: ${p.theme.diff.added};`};
  ${p => p.removed && `background-color: ${p.theme.diff.removed};`};
`;
