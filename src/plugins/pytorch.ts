/**
 * plugins/pytorch.ts — PyTorch stack plugin for Evolve AI
 *
 * Activates when the workspace contains PyTorch project markers.
 * Contributes:
 *  - contextHooks      : nn.Module subclasses, training script patterns
 *  - systemPromptSection: full PyTorch domain knowledge
 *  - codeLensActions   : Explain Model, Add Training Loop, Add Checkpoint
 *  - codeActions       : Add gradient clipping, lr scheduler, checkpointing, mixed precision
 *  - transforms        : Add type hints, Add logging/metrics
 *  - templates         : nn.Module classifier, Training loop, Custom Dataset, Inference script
 *  - commands          : explainModel, addTrainingLoop, addCheckpoint, optimizeTraining,
 *                        addMixedPrecision, generateDataset
 *  - statusItem        : shows count of nn.Module subclasses found
 */

import * as vscode from 'vscode';
import * as path   from 'path';
import * as fs     from 'fs';
import type {
  IPlugin,
  PluginContextHook,
  PluginCodeLensAction,
  PluginCodeAction,
  PluginTransform,
  PluginTemplate,
  PluginStatusItem,
  PluginCommand,
} from '../core/plugin';
import type { IServices } from '../core/services';
import type { AIRequest } from '../core/aiService';

// ── Detection patterns ────────────────────────────────────────────────────────

const TORCH_IMPORT = /import torch|from torch|import torchvision|import torchaudio/;
const TORCH_DEPS   = /\btorch\b|\bpytorch\b|\btorchvision\b|\btorchaudio\b/i;

function hasTorchInDeps(wsPath: string): boolean {
  for (const fname of ['requirements.txt', 'pyproject.toml', 'Pipfile', 'setup.py']) {
    const f = path.join(wsPath, fname);
    try {
      if (fs.existsSync(f)) {
        const content = fs.readFileSync(f, 'utf8');
        if (TORCH_DEPS.test(content)) { return true; }
      }
    } catch { /* skip */ }
  }
  return false;
}

// ── Helper: walk for specific file patterns ───────────────────────────────────

function globFiles(dir: string, patterns: RegExp[], maxFiles = 20): string[] {
  const results: string[] = [];
  const SKIP = new Set(['node_modules', '.git', '__pycache__', 'dist', 'build', '.venv', 'venv']);
  function walk(d: string): void {
    if (results.length >= maxFiles) { return; }
    try {
      for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
        if (SKIP.has(entry.name)) { continue; }
        const full = path.join(d, entry.name);
        if (entry.isDirectory()) { walk(full); }
        else if (patterns.some(p => p.test(entry.name))) { results.push(full); }
      }
    } catch { /* skip unreadable dirs */ }
  }
  walk(dir);
  return results;
}

// ── Context data shape ────────────────────────────────────────────────────────

interface PyTorchContext {
  modelClasses:     string[];
  trainingScripts:  string[];
  checkpointFiles:  string[];
  optimizerNames:   string[];
  lossNames:        string[];
  hasDataLoader:    boolean;
  hasAmp:           boolean;
  hasDistributed:   boolean;
  hasTorchScript:   boolean;
  modelCount:       number;
}

// ── Extract nn.Module subclass names from Python source ───────────────────────

const NN_MODULE_RE = /class\s+(\w+)\s*\(\s*(?:nn\.Module|torch\.nn\.Module)\s*\)/g;
const OPTIMIZER_RE = /(?:torch\.optim\.|optim\.)(\w+)\s*\(/g;
const LOSS_RE      = /(?:nn\.|torch\.nn\.)(\w+Loss\w*)\s*\(/g;

function extractModelClasses(src: string): string[] {
  const names: string[] = [];
  let m: RegExpExecArray | null;
  NN_MODULE_RE.lastIndex = 0;
  while ((m = NN_MODULE_RE.exec(src)) !== null) {
    names.push(m[1]);
  }
  return names;
}

function extractOptimizers(src: string): string[] {
  const names: string[] = [];
  let m: RegExpExecArray | null;
  OPTIMIZER_RE.lastIndex = 0;
  while ((m = OPTIMIZER_RE.exec(src)) !== null) {
    names.push(m[1]);
  }
  return [...new Set(names)];
}

function extractLossFns(src: string): string[] {
  const names: string[] = [];
  let m: RegExpExecArray | null;
  LOSS_RE.lastIndex = 0;
  while ((m = LOSS_RE.exec(src)) !== null) {
    names.push(m[1]);
  }
  return [...new Set(names)];
}

// ── The plugin ────────────────────────────────────────────────────────────────

export class PyTorchPlugin implements IPlugin {
  readonly id          = 'pytorch';
  readonly displayName = 'PyTorch';
  readonly icon        = '$(flame)';

  private _modelCount = 0;
  private _wsPath     = '';

  // ── detect ────────────────────────────────────────────────────────────────

  async detect(ws: vscode.WorkspaceFolder | undefined): Promise<boolean> {
    if (!ws) { return false; }
    const wsPath = ws.uri.fsPath;

    if (hasTorchInDeps(wsPath)) { return true; }

    // Scan Python files for torch imports
    const pyFiles = globFiles(wsPath, [/\.py$/], 50);
    for (const f of pyFiles) {
      try {
        const sample = fs.readFileSync(f, 'utf8').slice(0, 2000);
        if (TORCH_IMPORT.test(sample)) { return true; }
      } catch { /* skip */ }
    }

    return false;
  }

  // ── activate ──────────────────────────────────────────────────────────────

  async activate(services: IServices, _vsCtx: vscode.ExtensionContext): Promise<vscode.Disposable[]> {
    const ws = vscode.workspace.workspaceFolders?.[0];
    this._wsPath = ws?.uri.fsPath ?? '';

    // Count nn.Module subclasses for status item
    let count = 0;
    if (this._wsPath) {
      const pyFiles = globFiles(this._wsPath, [/\.py$/], 60);
      for (const f of pyFiles) {
        try {
          const src = fs.readFileSync(f, 'utf8');
          count += extractModelClasses(src).length;
        } catch { /* skip */ }
      }
    }
    this._modelCount = count;
    console.log(`[Evolve AI] PyTorch plugin activated: ${count} nn.Module subclasses found`);
    return [];
  }

  // ── contextHooks ──────────────────────────────────────────────────────────

  readonly contextHooks: PluginContextHook[] = [
    {
      key: 'pytorch.models',

      async collect(ws): Promise<unknown> {
        const wsPath = ws?.uri.fsPath ?? '';
        const models: Array<{ file: string; classes: string[] }> = [];

        const pyFiles = globFiles(wsPath, [/\.py$/], 60);
        for (const f of pyFiles) {
          try {
            const src = fs.readFileSync(f, 'utf8');
            const classes = extractModelClasses(src);
            if (classes.length > 0) {
              models.push({ file: path.relative(wsPath, f), classes });
            }
          } catch { /* skip */ }
        }

        // Check for checkpoint files
        const checkpoints = globFiles(wsPath, [/\.pt$/, /\.pth$/], 20)
          .map(f => path.relative(wsPath, f));

        return { models, checkpoints };
      },

      format(data: unknown): string {
        const d = data as { models: Array<{ file: string; classes: string[] }>; checkpoints: string[] };
        const lines: string[] = ['## PyTorch Models'];

        if (d.models.length > 0) {
          lines.push('### nn.Module subclasses:');
          for (const entry of d.models.slice(0, 10)) {
            lines.push(`- ${entry.file}: ${entry.classes.join(', ')}`);
          }
        } else {
          lines.push('(No nn.Module subclasses detected)');
        }

        if (d.checkpoints.length > 0) {
          lines.push(`### Checkpoint files: ${d.checkpoints.slice(0, 5).join(', ')}`);
        }

        return lines.join('\n');
      },
    },

    {
      key: 'pytorch.training',

      async collect(ws): Promise<unknown> {
        const wsPath = ws?.uri.fsPath ?? '';
        const trainingScripts: string[] = [];
        const optimizerNames: string[] = [];
        const lossNames: string[] = [];
        let hasDataLoader = false;
        let hasAmp        = false;
        let hasDistributed = false;
        let hasTorchScript = false;

        const pyFiles = globFiles(wsPath, [/\.py$/], 60);
        for (const f of pyFiles) {
          try {
            const src = fs.readFileSync(f, 'utf8');
            const isTraining = /optimizer\s*=|loss\s*=|\.backward\(\)|\.zero_grad\(\)|optimizer\.step\(\)/.test(src);
            if (isTraining) {
              trainingScripts.push(path.relative(wsPath, f));
            }
            for (const o of extractOptimizers(src)) {
              if (!optimizerNames.includes(o)) { optimizerNames.push(o); }
            }
            for (const l of extractLossFns(src)) {
              if (!lossNames.includes(l)) { lossNames.push(l); }
            }
            if (/DataLoader/.test(src))                     { hasDataLoader   = true; }
            if (/autocast|GradScaler|torch\.cuda\.amp/.test(src)) { hasAmp   = true; }
            if (/DistributedDataParallel|DataParallel|torch\.distributed/.test(src)) {
              hasDistributed = true;
            }
            if (/torch\.jit\.script|torch\.jit\.trace/.test(src)) { hasTorchScript = true; }
          } catch { /* skip */ }
        }

        return { trainingScripts, optimizerNames, lossNames, hasDataLoader, hasAmp, hasDistributed, hasTorchScript };
      },

      format(data: unknown): string {
        const d = data as {
          trainingScripts: string[];
          optimizerNames:  string[];
          lossNames:       string[];
          hasDataLoader:   boolean;
          hasAmp:          boolean;
          hasDistributed:  boolean;
          hasTorchScript:  boolean;
        };
        const lines: string[] = ['## PyTorch Training'];

        if (d.trainingScripts.length > 0) {
          lines.push(`### Training scripts: ${d.trainingScripts.slice(0, 5).join(', ')}`);
        }
        if (d.optimizerNames.length > 0) {
          lines.push(`### Optimizers in use: ${d.optimizerNames.join(', ')}`);
        }
        if (d.lossNames.length > 0) {
          lines.push(`### Loss functions in use: ${d.lossNames.join(', ')}`);
        }

        const features: string[] = [];
        if (d.hasDataLoader)   { features.push('DataLoader'); }
        if (d.hasAmp)          { features.push('Mixed Precision (AMP)'); }
        if (d.hasDistributed)  { features.push('Distributed Training'); }
        if (d.hasTorchScript)  { features.push('TorchScript'); }
        if (features.length > 0) {
          lines.push(`### Detected features: ${features.join(', ')}`);
        }

        return lines.join('\n');
      },
    },
  ];

  // ── systemPromptSection ───────────────────────────────────────────────────

  systemPromptSection(): string {
    return `
## PyTorch Expert Knowledge

You are an expert in PyTorch, deep learning, and the broader ML ecosystem. Apply these rules in every response involving PyTorch code:

### nn.Module
- All models must subclass nn.Module; define __init__ (call super().__init__()) and forward()
- Use self.parameters() / self.named_parameters() for optimizer setup; use state_dict() / load_state_dict() for checkpoints
- Register buffers (non-parameter tensors) with self.register_buffer(), not plain attributes
- Use model.train() / model.eval() appropriately — eval() disables Dropout and BatchNorm training mode
- Always wrap inference in torch.no_grad() to avoid unnecessary gradient tracking

### Layers
- Linear: nn.Linear(in_features, out_features, bias=True)
- Convolutional: nn.Conv2d(in_channels, out_channels, kernel_size, stride, padding)
- Recurrent: nn.LSTM(input_size, hidden_size, num_layers, batch_first=True, dropout)
            nn.GRU(input_size, hidden_size, num_layers, batch_first=True)
- Transformer: nn.Transformer, nn.TransformerEncoder, nn.TransformerEncoderLayer
               Use src_key_padding_mask for variable-length sequences
- Normalisation: nn.BatchNorm2d (training), nn.LayerNorm (NLP/Transformer), nn.GroupNorm
- Regularisation: nn.Dropout(p), nn.Dropout2d(p) for spatial dropout in CNNs
- Embedding: nn.Embedding(num_embeddings, embedding_dim, padding_idx=0)

### Loss Functions
- Classification: nn.CrossEntropyLoss (includes softmax — do NOT add softmax before it)
- Binary classification: nn.BCEWithLogitsLoss (numerically stable — do NOT use nn.BCELoss with sigmoid separately)
- Regression: nn.MSELoss, nn.L1Loss, nn.SmoothL1Loss (Huber)
- Custom losses: subclass nn.Module, implement forward(pred, target) → scalar tensor

### Optimizers
- Adam: torch.optim.Adam(model.parameters(), lr=1e-3, weight_decay=1e-4)
- AdamW: torch.optim.AdamW — preferred over Adam when using weight decay (decoupled)
- SGD: torch.optim.SGD(model.parameters(), lr=0.01, momentum=0.9, nesterov=True)
- LR Schedulers:
  - StepLR: decays every step_size epochs by gamma
  - CosineAnnealingLR: smooth cosine decay to eta_min
  - OneCycleLR: warmup then anneal — use with max_lr and total_steps
  - ReduceLROnPlateau: reduce on validation metric stagnation
  - Always call scheduler.step() after optimizer.step()

### Data Pipeline
- Dataset: subclass torch.utils.data.Dataset; implement __len__ and __getitem__
- IterableDataset: for streaming / large datasets that do not fit in memory
- DataLoader: torch.utils.data.DataLoader(dataset, batch_size=32, shuffle=True, num_workers=4, pin_memory=True)
  - pin_memory=True speeds up CPU→GPU transfers when using CUDA
  - num_workers > 0 enables multi-process loading; use 0 for debugging
  - collate_fn for custom batching of variable-length sequences (e.g., pad sequences)
  - Sampler: use WeightedRandomSampler for imbalanced datasets
- Transforms: torchvision.transforms.Compose([...]) for image pipelines
  - Normalize with per-channel mean/std; use standard ImageNet stats for pretrained models
  - Use transforms.v2 (torchvision ≥ 0.15) for faster and more composable augmentation

### Training Loop Best Practices
- Standard loop structure:
  1. optimizer.zero_grad()  ← call before each forward pass
  2. outputs = model(inputs)
  3. loss = criterion(outputs, targets)
  4. loss.backward()
  5. torch.nn.utils.clip_grad_norm_(model.parameters(), max_norm=1.0)  ← prevent exploding gradients
  6. optimizer.step()
  7. scheduler.step()
- Gradient accumulation: accumulate over N steps, call optimizer.step() and zero_grad() every N batches
- Early stopping: track validation metric; save best checkpoint; stop after patience epochs with no improvement

### Mixed Precision (AMP)
- Use torch.cuda.amp.autocast() context manager around forward + loss computation
- Use torch.cuda.amp.GradScaler to scale gradients; call scaler.scale(loss).backward(), scaler.step(optimizer), scaler.update()
- AMP is safe for most architectures; avoid for ops that require float32 precision (e.g., some loss functions)
- Example:
  scaler = GradScaler()
  with autocast():
      outputs = model(inputs)
      loss = criterion(outputs, targets)
  scaler.scale(loss).backward()
  scaler.step(optimizer)
  scaler.update()

### Distributed Training
- DataParallel: wraps model for multi-GPU on single node — simpler but less efficient
- DistributedDataParallel (DDP): preferred for multi-GPU and multi-node; use torch.distributed.init_process_group()
- FSDP (FullyShardedDataParallel): for very large models — shards parameters, gradients, and optimizer states
- Use DistributedSampler with DataLoader in distributed training; set shuffle=False in DataLoader

### TorchScript
- torch.jit.script: trace control flow and data-dependent shapes; requires type annotations
- torch.jit.trace: trace with example inputs; does not capture control flow
- Use torch.jit.optimize_for_inference() for deployment
- Export with model.save("model.pt"); load with torch.jit.load("model.pt")

### CUDA Device Management
- Check: device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
- Move model: model = model.to(device)
- Move tensors: x = x.to(device) or x = x.cuda()
- Memory: torch.cuda.empty_cache() to release cached allocations; use torch.cuda.memory_summary() to debug leaks
- Avoid repeated .to(device) calls in the training loop — move tensors once at batch loading

### Debugging & Profiling
- Gradient anomalies: use torch.autograd.detect_anomaly() context manager
- Gradient checking: torch.autograd.gradcheck(func, inputs) for custom autograd functions
- Profiler: torch.profiler.profile() with schedule, on_trace_ready — identifies CPU/GPU bottlenecks
- NaN detection: torch.isnan(loss).any() before backward(); anomaly detection for root cause

### Best Practices
- Reproducibility: torch.manual_seed(42); torch.cuda.manual_seed_all(42); torch.backends.cudnn.deterministic = True
- Weight initialisation: nn.init.kaiming_normal_ (ReLU), nn.init.xavier_uniform_ (Sigmoid/Tanh); apply with model.apply(init_fn)
- Checkpoint saving: save {'epoch': epoch, 'model_state_dict': model.state_dict(), 'optimizer_state_dict': optimizer.state_dict(), 'loss': loss}
- Model evaluation: always model.eval() + torch.no_grad() for val/test loops
- Metric tracking: use torchmetrics library for numerically correct distributed metrics
- Train/val/test split: use torch.utils.data.random_split() or Subset with explicit indices
`.trim();
  }

  // ── codeLensActions ───────────────────────────────────────────────────────

  readonly codeLensActions: PluginCodeLensAction[] = [
    {
      title:       '$(flame) Explain PyTorch model',
      command:     'aiForge.pytorch.explainModel',
      linePattern: /class\s+\w+\s*\(\s*(?:nn\.Module|torch\.nn\.Module)\s*\)/,
      languages:   ['python'],
      tooltip:     'Explain this nn.Module architecture and its components',
    },
    {
      title:       '$(flame) Generate training loop',
      command:     'aiForge.pytorch.addTrainingLoop',
      linePattern: /class\s+\w+\s*\(\s*(?:nn\.Module|torch\.nn\.Module)\s*\)/,
      languages:   ['python'],
      tooltip:     'Generate a complete training loop for this model',
    },
    {
      title:       '$(flame) Add model checkpoint',
      command:     'aiForge.pytorch.addCheckpoint',
      linePattern: /def\s+(?:train|fit|run_epoch|training_step)\w*/i,
      languages:   ['python'],
      tooltip:     'Add save/load checkpoint logic to this training function',
    },
  ];

  // ── codeActions (lightbulb) ───────────────────────────────────────────────

  readonly codeActions: PluginCodeAction[] = [
    {
      title:     '$(flame) PyTorch: Add gradient clipping',
      command:   'aiForge.pytorch.optimizeTraining',
      kind:      'quickfix',
      requiresSelection: false,
      languages: ['python'],
    },
    {
      title:     '$(flame) PyTorch: Add learning rate scheduler',
      command:   'aiForge.pytorch.optimizeTraining',
      kind:      'refactor',
      requiresSelection: false,
      languages: ['python'],
    },
    {
      title:     '$(flame) PyTorch: Add model checkpointing (save best)',
      command:   'aiForge.pytorch.addCheckpoint',
      kind:      'refactor',
      requiresSelection: false,
      languages: ['python'],
    },
    {
      title:     '$(flame) PyTorch: Add mixed precision training',
      command:   'aiForge.pytorch.addMixedPrecision',
      kind:      'refactor',
      requiresSelection: false,
      languages: ['python'],
    },
  ];

  // ── transforms ────────────────────────────────────────────────────────────

  readonly transforms: PluginTransform[] = [
    {
      label:       'Add type hints to all model definitions',
      description: 'Annotate nn.Module __init__ and forward() methods with proper type hints',
      extensions:  ['.py'],
      async apply(content: string, filePath: string, _lang: string, services: IServices): Promise<string> {
        const req: AIRequest = {
          messages: [{
            role: 'user',
            content: `Add complete Python type hints to all nn.Module class definitions in this file.
Rules:
- Annotate __init__ parameters and return type (-> None)
- Annotate forward() parameters (Tensors should be typed as torch.Tensor) and return type
- Add type hints to helper methods
- Import necessary types from torch and typing at the top
- Do NOT change any logic, only add type annotations
- Return ONLY the complete updated file with no explanation.

File: ${filePath}
\`\`\`python
${content}
\`\`\``,
          }],
          system: 'You are a PyTorch expert. Return only the complete updated Python file.',
          instruction: 'Add type hints to model definitions',
          mode: 'edit',
        };
        return (await services.ai.send(req)).replace(/^```[\w]*\n?|```\s*$/gm, '').trim();
      },
    },
    {
      label:       'Add logging/metrics to all training loops',
      description: 'Add loss tracking, metric logging, and progress reporting to training code',
      extensions:  ['.py'],
      async apply(content: string, filePath: string, _lang: string, services: IServices): Promise<string> {
        const req: AIRequest = {
          messages: [{
            role: 'user',
            content: `Add comprehensive logging and metric tracking to all training loops in this file.
Rules:
- Track and log training loss per epoch and per batch
- Add validation loss/metric tracking in the eval loop
- Use tqdm for progress bars (import if not present)
- Log to console with structured format: "Epoch {epoch}/{total} | Loss: {loss:.4f} | Val Loss: {val_loss:.4f}"
- Track best model metric for early stopping awareness
- Add timing information (epoch duration)
- Return ONLY the complete updated file with no explanation.

File: ${filePath}
\`\`\`python
${content}
\`\`\``,
          }],
          system: 'You are a PyTorch expert. Return only the complete updated Python file.',
          instruction: 'Add logging/metrics to training loops',
          mode: 'edit',
        };
        return (await services.ai.send(req)).replace(/^```[\w]*\n?|```\s*$/gm, '').trim();
      },
    },
  ];

  // ── templates ─────────────────────────────────────────────────────────────

  readonly templates: PluginTemplate[] = [
    {
      label:       'nn.Module classifier',
      description: 'A fully-connected or CNN classifier inheriting from nn.Module',
      prompt: (wsPath: string) =>
        `Create a production-quality PyTorch nn.Module classifier.
Include:
- Class inheriting from nn.Module with proper __init__ and forward()
- Configurable architecture (hidden sizes, dropout, activation) via __init__ parameters
- Type annotations on all methods (torch.Tensor, int, float)
- Docstring for the class and forward() method
- weight_init method using kaiming_normal_ for linear/conv layers
- A convenience function to instantiate the model and move to device
- Example usage in __main__ block with dummy input
Generate as ## classifier.py then the complete content.
Workspace: ${wsPath}`,
    },
    {
      label:       'Training loop with validation',
      description: 'Complete train/validation loop with checkpointing and early stopping',
      prompt: (wsPath: string) =>
        `Create a complete PyTorch training loop script with validation.
Include:
- train_epoch() and validate_epoch() functions
- Training loop with configurable epochs, early stopping (patience parameter)
- AdamW optimizer with CosineAnnealingLR scheduler
- Gradient clipping with torch.nn.utils.clip_grad_norm_
- Mixed precision with torch.cuda.amp.autocast and GradScaler
- Checkpoint saving: save best model based on validation loss
  Format: {'epoch', 'model_state_dict', 'optimizer_state_dict', 'val_loss'}
- Metric tracking: loss history lists for train and val
- tqdm progress bars
- Argument parsing with argparse for lr, epochs, batch_size, checkpoint_dir
- Device detection: cuda > mps > cpu
Generate as ## train.py then the complete content.
Workspace: ${wsPath}`,
    },
    {
      label:       'Custom Dataset + DataLoader',
      description: 'torch.utils.data.Dataset subclass with DataLoader setup',
      prompt: (wsPath: string) =>
        `Create a custom PyTorch Dataset and DataLoader setup.
Include:
- A Dataset subclass with __init__, __len__, __getitem__
- Type hints throughout
- Handling for data augmentation via optional transform parameter
- train/val split using torch.utils.data.random_split or Subset
- DataLoader creation for train and val with:
  - Appropriate batch_size, num_workers, pin_memory
  - WeightedRandomSampler for imbalanced datasets (optional via argument)
  - collate_fn example for variable-length sequences
- torchvision.transforms pipeline with Normalize
- __main__ block demonstrating iteration and shape inspection
Generate as ## dataset.py then the complete content.
Workspace: ${wsPath}`,
    },
    {
      label:       'Inference/prediction script',
      description: 'Load a trained model and run inference on new data',
      prompt: (wsPath: string) =>
        `Create a production PyTorch inference/prediction script.
Include:
- Model loading from checkpoint file (state_dict or full TorchScript)
- model.eval() + torch.no_grad() context
- Preprocessing pipeline matching training transforms
- Batched inference with DataLoader for large datasets
- Post-processing (argmax for classification, sigmoid for multi-label)
- Results output: JSON file and/or stdout
- Device detection with fallback to CPU
- Argument parsing: --model-path, --input, --output, --batch-size, --device
- Error handling for missing checkpoint or unsupported input format
Generate as ## inference.py then the complete content.
Workspace: ${wsPath}`,
    },
  ];

  // ── commands ──────────────────────────────────────────────────────────────

  readonly commands: PluginCommand[] = [
    {
      id:    'aiForge.pytorch.explainModel',
      title: 'Evolve AI: Explain PyTorch Model',
      async handler(services: IServices, uri: unknown, range: unknown): Promise<void> {
        const editor = vscode.window.activeTextEditor;
        if (!editor) { return; }
        const code = range
          ? editor.document.getText(range as vscode.Range)
          : editor.document.getText(editor.selection) || editor.document.getText();
        await vscode.commands.executeCommand(
          'aiForge._sendToChat',
          `Explain this PyTorch model architecture in detail, including:
- The overall architecture and design choices
- What each layer does and why it's placed where it is
- Parameter count and memory footprint estimate
- Input/output shape at each stage
- Potential issues or improvements (e.g., missing BatchNorm, suboptimal activation)

\`\`\`python
${code}
\`\`\``,
          'chat'
        );
      },
    },
    {
      id:    'aiForge.pytorch.addTrainingLoop',
      title: 'Evolve AI: Generate Training Loop',
      async handler(services: IServices): Promise<void> {
        const editor = vscode.window.activeTextEditor;
        if (!editor) { vscode.window.showWarningMessage('Open a file first'); return; }
        const code = editor.document.getText(editor.selection) || editor.document.getText();
        await vscode.commands.executeCommand(
          'aiForge._sendToChat',
          `Generate a complete training loop for the following PyTorch model.
Include:
- AdamW optimizer with CosineAnnealingLR scheduler
- Gradient clipping (max_norm=1.0)
- Mixed precision with autocast + GradScaler
- Train and validation epoch functions
- Early stopping with patience
- Checkpoint saving of the best model
- tqdm progress bars and per-epoch metric printing

\`\`\`python
${code}
\`\`\``,
          'new'
        );
      },
    },
    {
      id:    'aiForge.pytorch.addCheckpoint',
      title: 'Evolve AI: Add Model Checkpoint',
      async handler(services: IServices): Promise<void> {
        const editor = vscode.window.activeTextEditor;
        if (!editor) { vscode.window.showWarningMessage('Open a file first'); return; }
        await vscode.commands.executeCommand(
          'aiForge._sendToChat',
          `Add model checkpoint save and load logic to this training code.
- Save: {'epoch', 'model_state_dict', 'optimizer_state_dict', 'scheduler_state_dict', 'best_val_loss'}
- Save the best model when validation loss improves
- Add a resume_from_checkpoint option at the start of training
- Add torch.save() and torch.load() with map_location for device portability

\`\`\`python
${editor.document.getText()}
\`\`\``,
          'edit'
        );
      },
    },
    {
      id:    'aiForge.pytorch.optimizeTraining',
      title: 'Evolve AI: Optimize Training',
      async handler(services: IServices): Promise<void> {
        const editor = vscode.window.activeTextEditor;
        if (!editor) { vscode.window.showWarningMessage('Open a file first'); return; }
        const code = editor.document.getText(editor.selection) || editor.document.getText();

        await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: 'PyTorch: Optimising training…', cancellable: false },
          async () => {
            const ctx = await services.context.build();
            const sys = services.context.buildSystemPrompt(ctx);
            const req: AIRequest = {
              messages: [{
                role: 'user',
                content: `Optimise this PyTorch training code. Apply:
- Add gradient clipping if missing (clip_grad_norm_, max_norm=1.0)
- Add or improve the LR scheduler (prefer CosineAnnealingLR or OneCycleLR)
- Add DataLoader optimisations: pin_memory=True, num_workers, persistent_workers
- Add torch.backends.cudnn.benchmark = True for fixed input sizes
- Use in-place operations where safe to reduce memory allocation
- Fix any anti-patterns (e.g., loss.item() inside accumulation loop)
Return ONLY the optimised code, no explanation.

\`\`\`python
${code}
\`\`\``,
              }],
              system: sys,
              instruction: 'Optimise PyTorch training',
              mode: 'edit',
            };
            const output = (await services.ai.send(req)).replace(/^```[\w]*\n?|```\s*$/gm, '').trim();
            const ans = await vscode.window.showInformationMessage(
              'PyTorch: Optimised training code ready.', 'Apply to File', 'Show in Chat', 'Cancel'
            );
            if (ans === 'Apply to File') {
              await services.workspace.applyToActiveFile(output);
            } else if (ans === 'Show in Chat') {
              await vscode.commands.executeCommand('aiForge._sendToChat',
                `Here is the optimised training code:\n\`\`\`python\n${output}\n\`\`\``, 'chat');
            }
          }
        );
      },
    },
    {
      id:    'aiForge.pytorch.addMixedPrecision',
      title: 'Evolve AI: Add Mixed Precision',
      async handler(services: IServices): Promise<void> {
        const editor = vscode.window.activeTextEditor;
        if (!editor) { vscode.window.showWarningMessage('Open a file first'); return; }
        await vscode.commands.executeCommand(
          'aiForge._sendToChat',
          `Add mixed precision training (AMP) to this PyTorch training code.
- Import torch.cuda.amp.autocast and torch.cuda.amp.GradScaler
- Wrap forward pass and loss computation in autocast() context
- Replace loss.backward() with scaler.scale(loss).backward()
- Replace optimizer.step() with scaler.step(optimizer) and scaler.update()
- Ensure gradient clipping is done after scaler.unscale_(optimizer) if used
- Add GradScaler initialisation before the training loop

\`\`\`python
${editor.document.getText()}
\`\`\``,
          'edit'
        );
      },
    },
    {
      id:    'aiForge.pytorch.generateDataset',
      title: 'Evolve AI: Generate Dataset Class',
      async handler(services: IServices): Promise<void> {
        const editor = vscode.window.activeTextEditor;
        const context = editor ? editor.document.getText() : '';
        await vscode.commands.executeCommand(
          'aiForge._sendToChat',
          `Generate a custom PyTorch Dataset class for the following context.
Include:
- Dataset subclass with __init__, __len__, __getitem__
- Transform support (train transforms with augmentation, val transforms without)
- Proper type hints throughout
- DataLoader creation helper function with sensible defaults
- A WeightedRandomSampler example for imbalanced data (commented out)

${context ? `Context/existing code:\n\`\`\`python\n${context}\n\`\`\`` : '(No file open — generate a general-purpose Dataset template)'}`,
          'new'
        );
      },
    },
  ];

  // ── statusItem ────────────────────────────────────────────────────────────

  readonly statusItem: PluginStatusItem = {
    text: async (): Promise<string> => {
      const count = this._modelCount;
      return count > 0
        ? `$(flame) PyTorch (${count} model${count === 1 ? '' : 's'})`
        : `$(flame) PyTorch`;
    },
  };
}
