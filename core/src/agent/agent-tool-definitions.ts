import type { AgentToolDefinition } from './agent-tool-types.js';

export const CODE_AGENT_TOOLS: AgentToolDefinition[] = [
  {
    type: 'function',
    function: {
      name: 'active_task',
      description:
        'Persist one model-authored work unit across turns. Use set when accepting work that may be blocked/deferred, block when it cannot continue, complete only after disk mutation plus a successful model-requested Acceptance tool (tests/terminal/browser), and cancel/replace when the user changes direction. Automatic TypeScript diagnostics do not complete a task. Never infer a task from keywords.',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['set', 'block', 'complete', 'cancel'] },
          objective: { type: 'string', description: 'Concrete user outcome; required for set' },
          acceptance: { type: 'string', description: 'Disk/runtime completion condition; required for set' },
          blocker: { type: 'string', description: 'Current blocker; required for block' },
          reason: { type: 'string', description: 'Completion/cancellation reason' },
          related_paths: { type: 'array', items: { type: 'string' } },
        },
        required: ['action'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'task_history_search',
      description: 'Search compact task cards without loading chat transcripts or raw tool output. Use when prior work is referenced or remembered facts conflict.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Keywords, path, symbol, or prior decision' },
          limit: { type: 'number', description: 'Maximum cards (default 5, max 8)' },
          session_id: { type: 'string' },
          workspace_root: { type: 'string', description: 'Optional ranking boost; never deletes other roots' },
          status: { type: 'string', enum: ['active', 'completed', 'blocked', 'cancelled'] },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'task_history_detail',
      description: 'Expand one known taskId and one section. Prefer narrow sections; historical data is a hint, so reread current source before code claims.',
      parameters: {
        type: 'object',
        properties: {
          task_id: { type: 'string' },
          section: { type: 'string', enum: ['summary', 'decisions', 'failures', 'verification', 'execution', 'paths', 'all'] },
        },
        required: ['task_id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_directory',
      description:
        'List files and folders. Relative paths resolve under the chat/workspace context root; absolute and UNC paths (\\\\nas\\...) are allowed. Use before read/edit when path is unknown (default ".").',
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'Relative (under workspace context) or absolute/UNC directory path',
          },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_file',
      description:
        'Read exact source text through a fingerprint-validated local cache. Relative paths resolve under the workspace context root; absolute and UNC paths (\\\\nas\\...) are allowed. RAG/repo-map hits are candidates only: call read_file before factual claims or edits. Use start_line/end_line to avoid sending an entire file; set fresh=true when a forced source reread is required.',
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'Relative (under workspace context) or absolute/UNC file path',
          },
          start_line: { type: 'number', description: 'Optional 1-based inclusive first line' },
          end_line: { type: 'number', description: 'Optional 1-based inclusive last line' },
          fresh: { type: 'boolean', description: 'Bypass cached content and reread the source' },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'write_file',
      description:
        'Create or overwrite a text file. Relative → workspace context; absolute/UNC allowed (NAS write needs user consent).',
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'Relative (under workspace context) or absolute/UNC file path',
          },
          content: { type: 'string', description: 'Full file content' },
        },
        required: ['path', 'content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'edit_file',
      description:
        'Replace exact old_text with new_text. Paths: relative under workspace context, or absolute/UNC. Use replace_all for every occurrence. Prefer apply_patch for multi-hunk or multi-file edits.',
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'Relative (under workspace context) or absolute/UNC file path',
          },
          old_text: { type: 'string', description: 'Exact text to find' },
          new_text: { type: 'string', description: 'Replacement text' },
          replace_all: {
            type: 'boolean',
            description: 'Replace every occurrence (default false = first only)',
          },
        },
        required: ['path', 'old_text', 'new_text'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'apply_patch',
      description:
        'Atomic multi-hunk / multi-file surgical edits (all succeed or nothing is written). Prefer over rewrite for refactors. Pass either (1) patch text in *** Begin Patch format, or (2) files:[{path,edits:[{old_text,new_text}]}], or (3) single path+edits. old_text must be unique with context lines.',
      parameters: {
        type: 'object',
        properties: {
          patch: {
            type: 'string',
            description:
              'V4A/Codex-style patch: *** Begin Patch / *** Update File: path / @@ hunks with -/+ lines / *** End Patch',
          },
          files: {
            type: 'array',
            description: 'Structured multi-file patches',
            items: {
              type: 'object',
              properties: {
                path: { type: 'string' },
                action: {
                  type: 'string',
                  description: 'update | add | delete | move',
                },
                content: { type: 'string', description: 'Full content when action=add' },
                new_path: { type: 'string', description: 'Destination when action=move' },
                edits: {
                  type: 'array',
                  items: {
                    type: 'object',
                    properties: {
                      old_text: { type: 'string' },
                      new_text: { type: 'string' },
                      replace_all: { type: 'boolean' },
                    },
                    required: ['old_text', 'new_text'],
                  },
                },
              },
              required: ['path'],
            },
          },
          path: { type: 'string', description: 'Single-file path (with edits)' },
          edits: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                old_text: { type: 'string' },
                new_text: { type: 'string' },
                replace_all: { type: 'boolean' },
              },
              required: ['old_text', 'new_text'],
            },
          },
          replace_all: { type: 'boolean' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'delete_file',
      description:
        'Delete a file (relative under workspace context, or absolute/UNC). Requires prior read_file on the path and user approval (stream UI) or confirm=true. NAS delete needs consent.',
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'Relative or absolute/UNC file path to delete',
          },
          confirm: {
            type: 'boolean',
            description: 'Must be true after user approved deletion (non-stream fallback)',
          },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'rename_file',
      description:
        'Rename or move a file (relative under workspace context, or absolute/UNC; requires prior read_file on path)',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Current relative or absolute/UNC path' },
          new_path: { type: 'string', description: 'New relative or absolute/UNC path' },
        },
        required: ['path', 'new_path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'search_files',
      description:
        'Search files under a directory (ripgrep if available, else FTS token index). Default dir is workspace context root; absolute/UNC path allowed.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Search query (substring / tokens, or regex if regex=true)' },
          path: {
            type: 'string',
            description: 'Optional relative or absolute/UNC directory to search (default ".")',
          },
          regex: {
            type: 'boolean',
            description: 'Treat query as regex (uses ripgrep -e when available)',
          },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'query_repo_map',
      description:
        'Query cached repository symbols to locate candidate paths. Results are not authoritative file contents: use read_file on the relevant path/lines before factual claims or edits. Prefer for "where is X defined?" over guessing paths.',
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'Symbol name, path fragment, or import hint',
          },
          kind: {
            type: 'string',
            description: 'Optional symbol kind filter',
            enum: ['class', 'function', 'method', 'type', 'const', 'interface', 'enum'],
          },
          max_results: {
            type: 'number',
            description: 'Max hits (default 24)',
          },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'search_embeddings',
      description:
        'Semantic retrieval of candidate paths over the embedding index. Hits/previews are approximate and never authoritative; verify relevant source ranges with read_file. Uses local hashed TF by default; optional cloud embeddings fall back to local.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Natural-language or code intent query' },
          max_results: { type: 'number', description: 'Max hits (default 8)' },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'run_terminal',
      description:
        'Run a shell command in the dev workspace root (PowerShell). Requires user approval (stream UI) or confirm=true. Prefer run_tests for project tests.',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'PowerShell command to run (cwd = workspace root)' },
          confirm: {
            type: 'boolean',
            description: 'Must be true after user approved the command (non-stream fallback)',
          },
        },
        required: ['command'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'run_tests',
      description:
        'Detect and run the workspace test suite (npm test / pytest / cargo test / go test). Optional command override. Returns exit code and output.',
      parameters: {
        type: 'object',
        properties: {
          command: {
            type: 'string',
            description: 'Optional override (e.g. "npm run test:unit"). Empty = auto-detect.',
          },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'run_diagnostics',
      description:
        'Run workspace typecheck/lint diagnostics (tsc / eslint / oxlint / ruff / pyright). Prefer after edits before claiming success. Optional command override.',
      parameters: {
        type: 'object',
        properties: {
          command: {
            type: 'string',
            description: 'Optional override. Empty = auto-detect.',
          },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'workspace_checkpoint',
      description:
        'Create a file snapshot of listed paths under CQR data/agent-checkpoints. Use before risky multi-file edits. Not a git commit. paths is REQUIRED (full-tree snapshots are disabled).',
      parameters: {
        type: 'object',
        properties: {
          label: { type: 'string', description: 'Optional label for this checkpoint' },
          paths: {
            type: 'array',
            items: { type: 'string' },
            description: 'Required relative paths to snapshot (files you are about to edit)',
          },
        },
        required: ['paths'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'workspace_rollback',
      description:
        'Restore files from a prior workspace_checkpoint. Requires confirm=true (or UI Accept). Does not use git reset/stash.',
      parameters: {
        type: 'object',
        properties: {
          checkpoint_id: { type: 'string', description: 'Checkpoint id from workspace_checkpoint' },
          confirm: {
            type: 'boolean',
            description: 'Must be true after user approved rollback',
          },
        },
        required: ['checkpoint_id', 'confirm'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'git_init',
      description:
        'Initialize the selected workspace as a local Git repository. confirm=true only when the user explicitly asks to create/init a repo. Never initializes a parent folder.',
      parameters: {
        type: 'object',
        properties: { confirm: { type: 'boolean' } },
        required: ['confirm'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'git_status',
      description:
        'Show branch, HEAD, upstream ahead/behind, porcelain (read-only). For pull/compare, prefer git_sync_preview.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'git_sync_preview',
      description:
        'Cursor-style one-shot remote compare: optional fetch + local dirty/staged + incoming/outgoing commits and --stat. Use first for "pull and compare", "원격과 차이", "sync status". Does not pull/push.',
      parameters: {
        type: 'object',
        properties: {
          fetch: {
            type: 'boolean',
            description: 'Run git fetch first (default true)',
          },
          remote: { type: 'string', description: 'Remote name (default origin)' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'git_diff',
      description:
        'Diff: default unstaged; staged=true; range A..B / HEAD...@{upstream} for commit compare. Prefer git_sync_preview for high-level remote compare.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Optional relative file path' },
          staged: { type: 'boolean' },
          range: { type: 'string' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'git_log',
      description: 'Oneline log; range=HEAD..@{upstream} for incoming.',
      parameters: {
        type: 'object',
        properties: {
          range: { type: 'string' },
          max: { type: 'number' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'remote_git_inspect',
      description:
        'Public inspect under .my_agent_remote/: unshallow + full commit log without run_terminal policy fights. Prefer for GitHub history/chronology. Pass repo=.my_agent_remote/<owner>__<repo> or url=https://github.com/...',
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            description: 'ensure_full|unshallow|log|count|status (default ensure_full)',
          },
          repo: { type: 'string', description: '.my_agent_remote/<owner>__<repo>' },
          url: { type: 'string', description: 'Public git URL to derive .my_agent_remote folder' },
          max: { type: 'number', description: 'Max log lines (default 80)' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'repomix_pack',
      description: 'Pack workspace context via repomix CLI if installed (knowledge).',
      parameters: {
        type: 'object',
        properties: {
          args: { type: 'array', items: { type: 'string' } },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'ast_grep_search',
      description: 'Structural search via ast-grep/sg CLI if installed.',
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string' },
          lang: { type: 'string' },
        },
        required: ['pattern'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'markitdown_convert',
      description:
        'Convert a local office/doc/pdf/html file to markdown via markitdown sidecar (Wave 3). Pass absolute or workspace-relative path.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path to convert' },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'git_history_tree',
      description:
        'Git history as ASCII --graph plus structured commit list (parents, refs, subject). Use when user wants to see history/branch tree/commit graph. Prefer over plain git_log for “히스토리 트리”.',
      parameters: {
        type: 'object',
        properties: {
          max: { type: 'number', description: 'Max commits (default 30, max 80)' },
          all: { type: 'boolean', description: 'Include all refs (--all)' },
          first_parent: {
            type: 'boolean',
            description: 'Linearize merges via --first-parent',
          },
          path: { type: 'string', description: 'Limit history to relative file/dir' },
          range: { type: 'string', description: 'Optional A..B range' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'git_show',
      description: 'Show a commit or file-at-ref (read-only). ref default HEAD.',
      parameters: {
        type: 'object',
        properties: {
          ref: { type: 'string' },
          path: { type: 'string' },
          stat_only: { type: 'boolean' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'git_blame',
      description: 'git blame for a relative file path (read-only).',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          max: { type: 'number', description: 'Max lines from start (default 200)' },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'git_branch',
      description: 'List branches (default) or create a branch (confirm=true). Does not switch.',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', description: 'list | create' },
          name: { type: 'string' },
          all: { type: 'boolean', description: 'Include remotes when listing' },
          confirm: { type: 'boolean' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'git_switch',
      description:
        'Switch branch (git switch). confirm=true required. Refuses dirty tree unless force_dirty=true. create=true makes new branch and switches.',
      parameters: {
        type: 'object',
        properties: {
          branch: { type: 'string' },
          confirm: { type: 'boolean' },
          create: { type: 'boolean' },
          force_dirty: { type: 'boolean' },
        },
        required: ['branch', 'confirm'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'git_stage',
      description: 'Stage paths or all_tracked (add -u). unstage=true uses restore --staged.',
      parameters: {
        type: 'object',
        properties: {
          paths: { type: 'array', items: { type: 'string' } },
          all_tracked: { type: 'boolean' },
          unstage: { type: 'boolean' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'git_restore',
      description:
        'Restore paths. mode=staged (unstage), worktree (discard edits, confirm=true), both (confirm=true).',
      parameters: {
        type: 'object',
        properties: {
          paths: { type: 'array', items: { type: 'string' } },
          mode: { type: 'string', description: 'worktree | staged | both' },
          confirm: { type: 'boolean' },
        },
        required: ['paths'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'git_stash',
      description:
        'list | push (-u) | pop/drop (confirm=true, index default 0). Safe alternative before switch/pull when dirty.',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string' },
          message: { type: 'string' },
          confirm: { type: 'boolean' },
          index: { type: 'number' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'git_fetch',
      description:
        'Fetch only (tree unchanged). Prefer git_sync_preview for compare workflows. For public `.my_agent_remote/<owner>__<repo>` history deepen: pass repo= that path and unshallow=true (or run_terminal `git -C .my_agent_remote/... fetch --unshallow`).',
      parameters: {
        type: 'object',
        properties: {
          remote: { type: 'string' },
          prune: { type: 'boolean' },
          unshallow: {
            type: 'boolean',
            description: 'Deepen a shallow clone (use with repo=.my_agent_remote/...)',
          },
          repo: {
            type: 'string',
            description: 'Workspace-relative `.my_agent_remote/<owner>__<repo>` for public inspect only',
          },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'git_pull',
      description:
        'pull --ff-only. confirm=true. Prefer git_sync_preview first. Not via run_terminal.',
      parameters: {
        type: 'object',
        properties: {
          confirm: { type: 'boolean' },
          remote: { type: 'string' },
          branch: { type: 'string' },
        },
        required: ['confirm'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'git_push',
      description:
        'Push (no force ever). confirm=true only when user explicitly asks. set_upstream for -u. Not via run_terminal.',
      parameters: {
        type: 'object',
        properties: {
          confirm: { type: 'boolean' },
          remote: { type: 'string' },
          branch: { type: 'string' },
          set_upstream: { type: 'boolean' },
        },
        required: ['confirm'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'git_commit',
      description:
        'Stage and commit. confirm=true. Without paths: add -u. Never force. Push only via separate git_push.',
      parameters: {
        type: 'object',
        properties: {
          message: { type: 'string' },
          confirm: { type: 'boolean' },
          paths: { type: 'array', items: { type: 'string' } },
        },
        required: ['message', 'confirm'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'plugin_list',
      description:
        'List local agent plugins under data/agent-plugins (enabled flag, name, risk). Use when a capability may be a local plugin.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'plugin_scaffold',
      description:
        'Dry-run: propose id, tool.json, and run.mjs for a new local plugin (purpose-aware recipes: line count, sum, upper, md list, json keys). Does not write disk. If purpose matches a shipped template, response includes prefer_template_id — install that template instead. Then freeform plugin_install needs UI Accept.',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Plugin id [a-z0-9_]' },
          purpose: { type: 'string', description: 'What the tool does' },
          risk: { type: 'string', description: 'read | write | network' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'plugin_install',
      description:
        'Install a local plugin to data/agent-plugins/{id}. confirm=true required. Pass template_id (shipped blueprint, no UI Accept) OR tool_json+run_source freeform (UI Accept / HITL). Prefer templates over freeform.',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          confirm: { type: 'boolean' },
          tool_json: {
            type: 'string',
            description: 'tool.json object as JSON string (or structured object if allowed)',
          },
          run_source: { type: 'string', description: 'Full file body for runner entry' },
          template_id: {
            type: 'string',
            description: 'Install from tools/plugin-templates/{template_id} (skips tool_json/run_source)',
          },
        },
        required: ['confirm'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'plugin_set_enabled',
      description: 'Enable or disable a local plugin. confirm=true required.',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          enabled: { type: 'boolean' },
          confirm: { type: 'boolean' },
        },
        required: ['id', 'enabled', 'confirm'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'save_web_asset',
      description:
        'Download an http(s) image or text file into session temp data/outputs/web/<session>/. Use for reference material. Do NOT write into the user workspace unless they asked to keep the file in the project. Max 20MB.',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'http or https URL to download' },
          filename: { type: 'string', description: 'Optional filename under the session temp folder' },
        },
        required: ['url'],
      },
    },
  },
];

export const BROWSER_AGENT_TOOLS: AgentToolDefinition[] = [
  {
    type: 'function',
    function: {
      name: 'browser_navigate',
      description:
        'Open an http(s) URL in headless Chromium. Use before browser_screenshot on a new site. External URLs allowed; localhost only if enabled in settings.',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'http or https URL to open' },
        },
        required: ['url'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'browser_screenshot',
      description:
        'Capture a full-page PNG after browser_navigate. Saves under data/outputs/browser/<session>/ (chat temp, deleted with the chat). Pass a .playwright/ path only when the user asked to keep a screenshot in the workspace.',
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description:
              'Optional path. Default: data/outputs/browser/<session>/screenshot-*.png. Use .playwright/<session>/file.png only to keep it in the workspace.',
          },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'browser_click',
      description: 'Click an element matching a CSS selector on the current page',
      parameters: {
        type: 'object',
        properties: {
          selector: { type: 'string', description: 'CSS selector' },
        },
        required: ['selector'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'browser_fill',
      description: 'Fill an input or textarea matched by CSS selector',
      parameters: {
        type: 'object',
        properties: {
          selector: { type: 'string', description: 'CSS selector' },
          value: { type: 'string', description: 'Text value to enter' },
        },
        required: ['selector', 'value'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'browser_evaluate',
      description: 'Run JavaScript in the page context and return the result (DOM checks, assertions)',
      parameters: {
        type: 'object',
        properties: {
          expression: { type: 'string', description: 'JavaScript expression to evaluate' },
        },
        required: ['expression'],
      },
    },
  },
];

export const CODE_AGENT_TOOL_NAMES = CODE_AGENT_TOOLS.map((t) => t.function.name);
