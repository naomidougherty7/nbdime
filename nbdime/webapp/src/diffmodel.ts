// Copyright (c) Jupyter Development Team.
// Distributed under the terms of the Modified BSD License.
'use strict';

import {
  nbformat
} from 'jupyterlab/lib/notebook/notebook/nbformat';

import {
  DiffOp, IDiffEntry, IDiffAddRange, IDiffRemoveRange, IDiffPatch, getDiffKey,
  DiffRangeRaw, DiffRangePos, raw2Pos
} from './diffutil';
    
import {
  patchStringified, stringify, patch
} from './patch';

import * as CodeMirror from 'codemirror';

// CHUNKING

/**
 * A chunk is a range of lines in a string based diff
 * that logically belong together.
 * 
 * Chunks can be used for:
 *  - Correlating diff entries in the base and remote, e.g. 
 *    for aligning lines in two editors. 
 *  - Finding parts of the unchanged text that are not needed 
 *    as context (can be hidden)
 *  - Navigating a diff ("Go to next diff")
 */
export class Chunk {
  constructor(
    public editFrom: number,
    public editTo: number,
    public origFrom: number,
    public origTo: number) {}
    
  /**
   * Checks whether the given line number is within the range spanned by editFrom - editTo
   */
  inEdit(line: number) {
    return line >= this.editFrom && line <= this.editTo;
  }
  
  /**
   * Checks whether the given line number is within the range spanned by origFrom - origTo
   */
  inOrig(line: number) {
    return line >= this.origFrom && line <= this.origTo;
  }
};


// DIFF MODELS:

/**
 * Describes a model whose view can be collapsible.
 * 
 * Intended as hints for a view of the model, and not a requirement.
 */
export interface ICollapsibleModel {
  /** 
   * Whether a view of the model should be collapsible (hint)
   */ 
  collapsible: boolean;
  
  /** 
   * String to show in header of collapser element 
   */ 
  collapsibleHeader: string;

  /**
   * The initial state of a collapsible view
   */
  startCollapsed: boolean;
}

/**
 * Base interface for diff models.
 */
export interface IDiffModel extends ICollapsibleModel {
  /** 
   * Is diff no-op?
   */ 
  unchanged: boolean;

  /** 
   * Whether diff represents a simple addtion
   */ 
  added: boolean;

  /** 
   * Whether diff represents a simple deletion
   */ 
  deleted: boolean;
}


/**
 * Interface for a string diff models.
 * 
 * String diff models are used for any content where the final
 * diff should be presented as a difference between strings
 * (as compared to e.g. images). As such, it is NOT restricted
 * to cases where original content is in a string format. 
 */
export interface IStringDiffModel extends IDiffModel { 
  /** 
   * Base value
   */  
  base: string;

  /** 
   * Remote value
   */  
  remote: string;

  /**
   * Mimetype of the data the string represents.
   * 
   * Can be used for things such as syntax highlighting.
   */
  mimetype: string;
  
  /** 
   * Location of additions, as positions in the remote value.
   * 
   * Locations should be sorted on the ranges' `from` position
   */
  additions: DiffRangePos[];

  /** 
   * Location of deletions, as positions in the base value.
   * 
   * Locations should be sorted on the ranges' `from` position
   */
  deletions: DiffRangePos[];
  
  
  /** 
   * A function that will separate the diff into chunks.
   */
  getChunks(): Chunk[];
}


/**
 * Standard implementation of the IStringDiffModel interface.
 */
export class StringDiffModel implements IStringDiffModel {

  /**
   * StringDiffModel constructor.
   * 
   * Will translate additions and deletions from absolute
   * coordinates, into {line, ch} based coordinates.
   * Both should be sorted on the `from` position before passing.
   * 
   * Collapsible and collapsed both defaults to false.
   */
  constructor(
        public base: string,
        public remote:string,
        additions: DiffRangeRaw[],
        deletions: DiffRangeRaw[],
        collapsible?: boolean,
        header?: string,
        collapsed?: boolean) {
    if (base === null) {
      console.assert(deletions.length === 0);
      this.deletions = [];
    } else {
      this.deletions = raw2Pos(deletions, base);
    }
    if (remote === null) {
      console.assert(additions.length === 0);
      this.additions = [];
    } else {
      this.additions = raw2Pos(additions, remote);
    }
    
    this.collapsible = collapsible === true;
    if (this.collapsible) {
      this.collapsibleHeader = header ? header : '';
      this.startCollapsed = collapsed;
    }
  }

  /**
   * Uses Chunk.inOrig/inEdit to determine diff entry overlap.
   */
  getChunks(): Chunk[] {
    var chunks: Chunk[] = [];
    var startEdit = 0, startOrig = 0, editOffset = 0;
    var edit = CodeMirror.Pos(0, 0), orig = CodeMirror.Pos(0, 0);
    let ia = 0, id = 0;
    
    let current: Chunk = null;
    let isAddition: boolean = null;
    let range: DiffRangePos = null;
    for (;;) {
      // Figure out which element to take next
      if (ia < this.additions.length) {
        if (id < this.deletions.length) {
          let ra = this.additions[ia], rd = this.deletions[id];
          if (ra.from.line < rd.from.line - editOffset ||
                (ra.from.line == rd.from.line - editOffset &&
                 ra.from.ch <= rd.from.ch)) {
            // TODO: Character editOffset should also be used
            isAddition = true;
          } else {
            isAddition = false;
          }
        } else {
          // No more deletions
          isAddition = true;
        }
      } else if (id < this.deletions.length) {
        // No more additions
        isAddition = false;
      } else {
        if (current) { chunks.push(current); }
        break;
      }
      
      if (isAddition) {
        range = this.additions[ia++];
      } else {
        range = this.deletions[id++];
      }
      let linediff = range.to.line - range.from.line;
      if (range.endsOnNewline) {
        linediff += 1;
      }
      let firstLineNew = range.from.ch === 0 && linediff > 0;

      let startOffset = range.chunkStartLine ? 0 : 1;
      let endOffset = 
        range.chunkStartLine && range.endsOnNewline && firstLineNew ?
        0 : 1;

      if (current) {
        if (isAddition) {
          if (current.inOrig(range.from.line)) {
            current.origTo = Math.max(current.origTo,
                                      range.to.line + 1);
          } else {
            // No overlap with chunk, start new one
            chunks.push(current);
            current = null;
          }
        } else {
          if (current.inEdit(range.from.line)) {
            current.editTo = Math.max(current.editTo,
                                      range.to.line + 1);
          } else {
            // No overlap with chunk, start new one
            chunks.push(current);
            current = null;
          }
        }
      }
      if (!current) {
        if (isAddition) {
          startOrig = range.from.line;
          startEdit = startOrig + editOffset;
          current = new Chunk(
            startEdit + startOffset,
            startEdit + endOffset,
            startOrig + startOffset,
            startOrig + endOffset + linediff
          );
        } else {
          startEdit = range.from.line;
          startOrig = startEdit - editOffset;
          current = new Chunk(
            startEdit + startOffset,
            startEdit + endOffset + linediff,
            startOrig + startOffset,
            startOrig + endOffset
          );
        }
      }
      editOffset += isAddition ? -linediff : linediff;
    }
    return chunks;
  }
    
  get unchanged(): boolean {
    return this.base == this.remote;
    //return !this.additions && !this.deletions;
  }
  
  get added(): boolean {
    return this.base === null;
  }
  
  get deleted(): boolean {
    return this.remote === null;
  }
  
  collapsible: boolean;
  collapsibleHeader: string;
  startCollapsed: boolean;

  mimetype: string;
  
  additions: DiffRangePos[];
  deletions: DiffRangePos[];
}


/**
 * Creates a StringDiffModel based on a patch operation.
 * 
 * If base is not a string, it is assumed to be a JSON object,
 * and it will be stringified according to JSON stringification
 * rules.
 */
export function createPatchDiffModel(base: any, diff: IDiffEntry[]) : StringDiffModel {
  console.assert(!!diff, 'Patch model needs diff.');
  var base_str = (typeof base == 'string') ? base as string : stringify(base);
  let out = patchStringified(base, diff);
  return new StringDiffModel(base_str, out.remote, out.additions, out.deletions);
}

/**
 * Factory for creating cell diff models for added, removed or unchanged content.
 * 
 * If base is null, it will be treated as added, if remote is null it will be 
 * treated as removed. Otherwise base and remote should be equal, represeting 
 * unchanged content.
 */
export function createDirectDiffModel(base: any, remote: any): StringDiffModel {
  var base_str = (typeof base == 'string') ? 
    base as string : stringify(base);
  var remote_str = (typeof remote == 'string') ? 
    remote as string : stringify(remote);
  var additions: DiffRangeRaw[] = [];
  var deletions: DiffRangeRaw[] = []

  if (base === null) {
    // Added cell
    base_str = null;
    additions.push(new DiffRangeRaw(0, remote_str.length));
  } else if (remote === null) {
    // Deleted cell
    remote_str = null;
    deletions.push(new DiffRangeRaw(0, base_str.length));
  } else if (remote_str !== base_str) {
    throw 'Invalid arguments to createDirectDiffModel().' + 
      'Either base or remote should be null, or they should be equal!'
  }
  return new StringDiffModel(base_str, remote_str, additions, deletions);
}



/**
 * Assign MIME type to an IStringDiffModel based on the cell type.
 * 
 * The parameter nbMimetype is the MIME type set for the entire notebook, and is used as the
 * MIME type for code cells.
 */
function setMimetypeFromCellType(model: IStringDiffModel, cell: nbformat.ICell, 
      nbMimetype: string) {
  let cellType = cell.cell_type;
  if (cellType === 'code') {
    model.mimetype = nbMimetype;
  } else if (cellType === 'markdown') {
    model.mimetype = 'text/markdown';
  } else if (cellType === 'raw') {
    model.mimetype = (cell as nbformat.IRawCell).metadata.format;
  }
}


/**
 * Diff model for single cell output entries.
 * 
 * Can converted to a StringDiffModel via the method `stringify()`, which also 
 * takes an optional argument `key` which specifies a subpath of the IOutput to
 * make the model from.
 */
export class OutputDiffModel implements IDiffModel {
  constructor(
        public base: nbformat.IOutput,
        remote: nbformat.IOutput,
        diff?: IDiffEntry[],
        collapsible?: boolean,
        header?: string,
        collapsed?: boolean) {
    if (!remote && diff) {
      this.remote = patch(base, diff) as nbformat.IOutput;
    } else {
      this.remote = remote;
    }
    this.diff = !!diff ? diff : null;
    this.collapsible = collapsible === true;
    if (this.collapsible) {
      this.collapsibleHeader = header ? header : '';
      this.startCollapsed = collapsed;
    }
  }
  
  get unchanged() : boolean {
    return this.diff === null;
  }
  
  get added(): boolean {
    return this.base === null;
  }
  
  get deleted(): boolean {
    return this.remote === null;
  }

  /**
   * Checks whether the given mimetype is present in the output's mimebundle.
   * If so, it returns the path/key to that mimetype's data. If not present, 
   * it returns null. 
   * 
   * See also: innerMimeType
   */
  hasMimeType(mimetype: string): string {
    let t = this.base ? this.base.output_type : this.remote.output_type;
    if (t === 'stream' && 
          mimetype == 'application/vnd.jupyter.console-text') {
      return 'text';
    } else if (t === 'execute_result' || t === 'display_data') {
      let data = this.base ? (this.base as nbformat.IExecuteResult).data : 
        (this.remote as nbformat.IExecuteResult).data;
      if (mimetype in data) {
        return 'data.' + mimetype;
      }
    }
    return null;
  }

  /**
   * Returns the expected MIME type of the IOutput subpath specified by `key`,
   * as determined by the notebook format specification.
   * 
   * Throws an error for unknown keys.
   * 
   * See also: hasMimeType
   */
  innerMimeType(key: string) : string {
    let t = this.base ? this.base.output_type : this.remote.output_type;
    if (t === 'stream' && key === 'text') {
      // TODO: 'application/vnd.jupyter.console-text'?
      return 'text/plain';
    } else if ((t === 'execute_result' || t === 'display_data') &&
          key.indexOf('data.') === 0) {
      return key.slice('data.'.length);
    }
    throw 'Unknown MIME type for key: ' + key;
  }
  
  /**
   * Can converted to a StringDiffModel via the method `stringify()`, which also 
   * takes an optional argument `key` which specifies a subpath of the IOutput to
   * make the model from.
   */
  stringify(key?: string) : IStringDiffModel {
    let getMemberByPath = function(obj: any, key: string, f?: (obj: any, key: string) => any) {
      if (!obj) return obj;
      let i = key.indexOf('.');
      if (i >= 0) {
        console.assert(i < key.length);
        if (f) {
          return getMemberByPath(
            f(obj, key.slice(0, i)), key.slice(i+1), f);
        }
        return getMemberByPath(
          obj[key.slice(0, i)], key.slice(i+1), f);
      } else if (f) {
        return f(obj, key);
      }
      return obj[key];
    };
    let base = key ? getMemberByPath(this.base, key) : this.base;
    let remote = key ? getMemberByPath(this.remote, key) : this.remote;
    let diff = this.diff && key ? 
      getMemberByPath(this.diff, key, getDiffKey) :
      this.diff;
    let model: IStringDiffModel = null;
    if (this.unchanged || this.added || this.deleted || !diff) {
      model = createDirectDiffModel(base, remote);
    } else {
      model = createPatchDiffModel(base, diff);
    }
    model.mimetype = key ? this.innerMimeType(key) : 'application/json';
    model.collapsible = this.collapsible;
    model.collapsibleHeader = this.collapsibleHeader;
    model.startCollapsed = this.startCollapsed;
    return model;
  }
  
  /**
   * Remote value
   */
  remote: nbformat.IOutput;

  /**
   * Diff entries between base and remote
   */
  diff: IDiffEntry[];

  // ICollapsibleModel:
  collapsible: boolean;
  collapsibleHeader: string;
  startCollapsed: boolean;
}

