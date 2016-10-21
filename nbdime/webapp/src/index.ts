// Copyright (c) Jupyter Development Team.
// Distributed under the terms of the Modified BSD License.
'use strict';

import {
  initializeDiff
} from './app/diff';

import {
  initializeMerge, closeMerge
} from './app/merge';

import {
  closeTool, getConfigOption
} from './app/common';

/** */
function initialize() {
  let onclose = (ev) => { closeTool(); };
  if (getConfigOption('local') || document.getElementById('merge-local')) {
    initializeMerge();
    onclose = closeMerge;
  } else {
    initializeDiff();
  }

  // If launched as a tool, there should be a close button, to indicate that
  // the tool has finshed. If present, wire it to events, and connect to
  // window unload event as well:
  let closeBtn = document.getElementById('nbdime-close') as HTMLButtonElement;
  if (closeBtn) {
    closeBtn.onclick = onclose;
    window.onbeforeunload = onclose;
  }
}

window.onload = initialize;
