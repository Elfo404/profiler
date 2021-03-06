/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// @flow

import {
  attemptToPublish,
  resetUploadState,
  abortUpload,
  toggleCheckedSharingOptions,
  revertToPrePublishedState,
} from '../../actions/publish';
import { changeSelectedTab } from '../../actions/app';
import {
  viewProfileFromPathInZipFile,
  returnToZipFileList,
} from '../../actions/zipped-profiles';
import {
  getCheckedSharingOptions,
  getUploadPhase,
  getUploadError,
  getUploadProgress,
  getUploadGeneration,
} from '../../selectors/publish';
import {
  getSelectedTab,
  getDataSource,
  getProfileName,
} from '../../selectors/url-state';
import { getHasZipFile } from '../../selectors/zipped-profiles';
import { getProfileFromTextSamples } from '../fixtures/profiles/processed-profile';
import { storeWithProfile } from '../fixtures/stores';
import { TextEncoder } from 'util';
import { ensureExists } from '../../utils/flow';
import { waitUntilState } from '../fixtures/utils';
import { storeWithZipFile } from '../fixtures/profiles/zip-file';

import type { Store } from '../../types/store';

// Mocks:
import { uploadBinaryProfileData } from '../../profile-logic/profile-store';
jest.mock('../../profile-logic/profile-store');

describe('getCheckedSharingOptions', function() {
  describe('default filtering by channel', function() {
    const isFiltering = {
      includeExtension: false,
      includeFullTimeRange: false,
      includeHiddenThreads: false,
      includeScreenshots: false,
      includeUrls: false,
      includePreferenceValues: false,
    };
    const isNotFiltering = {
      includeExtension: true,
      includeFullTimeRange: true,
      includeHiddenThreads: true,
      includeScreenshots: true,
      includeUrls: true,
      includePreferenceValues: true,
    };
    function getDefaultsWith(updateChannel: string) {
      const { profile } = getProfileFromTextSamples('A');
      profile.meta.updateChannel = updateChannel;
      const { getState } = storeWithProfile(profile);
      return getCheckedSharingOptions(getState());
    }

    it('does not filter with nightly', function() {
      expect(getDefaultsWith('nightly')).toEqual(isNotFiltering);
    });

    it('does not filter with nightly-try', function() {
      expect(getDefaultsWith('nightly-try')).toEqual(isNotFiltering);
    });

    it('does not filter with default', function() {
      expect(getDefaultsWith('default')).toEqual(isNotFiltering);
    });

    it('does not filter local builds', function() {
      expect(getDefaultsWith('nightly-autoland')).toEqual(isNotFiltering);
    });

    it('does filter with aurora', function() {
      expect(getDefaultsWith('aurora')).toEqual(isFiltering);
    });

    it('does filter with release', function() {
      expect(getDefaultsWith('release')).toEqual(isFiltering);
    });
  });
  describe('toggleCheckedSharingOptions', function() {
    it('can toggle options', function() {
      const { profile } = getProfileFromTextSamples('A');
      const { getState, dispatch } = storeWithProfile(profile);
      expect(getCheckedSharingOptions(getState())).toMatchObject({
        includeHiddenThreads: false,
      });

      dispatch(toggleCheckedSharingOptions('includeHiddenThreads'));

      expect(getCheckedSharingOptions(getState())).toMatchObject({
        includeHiddenThreads: true,
      });

      dispatch(toggleCheckedSharingOptions('includeHiddenThreads'));

      expect(getCheckedSharingOptions(getState())).toMatchObject({
        includeHiddenThreads: false,
      });
    });
  });
});

describe('attemptToPublish', function() {
  beforeEach(function() {
    if ((window: any).TextEncoder) {
      throw new Error('A TextEncoder was already on the window object.');
    }
    (window: any).TextEncoder = TextEncoder;
  });

  afterEach(async function() {
    delete (window: any).TextEncoder;
  });

  function setupFakeUploadsWithStore(store: Store): * {
    let updateUploadProgress;
    let resolveUpload;
    let rejectUpload;
    const abortFunction = jest.fn();
    const promise = new Promise((resolve, reject) => {
      resolveUpload = resolve;
      rejectUpload = reject;
    });

    promise.catch(() => {
      // Node complains if we don't handle a promise/catch, and this one rejects
      // before it's properly handled. Catch it here so that Node doesn't complain.
    });

    const initUploadProcess: typeof uploadBinaryProfileData = () => ({
      abortFunction,
      startUpload: (data, callback) => {
        updateUploadProgress = callback;
        return promise;
      },
    });
    (uploadBinaryProfileData: any).mockImplementation(initUploadProcess);

    jest.spyOn(window, 'open').mockImplementation(() => {});

    function getUpdateUploadProgress() {
      return ensureExists(
        updateUploadProgress,
        'Expected to get a reference to the callback to update the upload progress.'
      );
    }

    function waitUntilPhase(phase) {
      return waitUntilState(store, state => getUploadPhase(state) === phase);
    }

    return {
      ...store,
      resolveUpload,
      rejectUpload,
      getUpdateUploadProgress,
      waitUntilPhase,
      abortFunction,
    };
  }

  function setup() {
    const { profile } = getProfileFromTextSamples('A');
    const store = storeWithProfile(profile);
    return setupFakeUploadsWithStore(store);
  }

  it('cycles through the upload phases on a successful upload', async function() {
    const { dispatch, getState, resolveUpload } = setup();
    expect(getUploadPhase(getState())).toEqual('local');
    const publishAttempt = dispatch(attemptToPublish());
    expect(getUploadPhase(getState())).toEqual('compressing');
    resolveUpload('FAKEHASH');

    expect(await publishAttempt).toEqual(true);

    expect(getUploadPhase(getState())).toEqual('uploaded');
  });

  it('can handle upload errors', async function() {
    const { dispatch, getState, rejectUpload } = setup();
    const publishAttempt = dispatch(attemptToPublish());
    const error = new Error('fake error');
    rejectUpload(error);

    expect(await publishAttempt).toEqual(false);

    expect(getUploadPhase(getState())).toBe('error');
    expect(getUploadError(getState())).toBe(error);
  });

  it('updates with upload progress', async function() {
    const {
      waitUntilPhase,
      dispatch,
      getState,
      resolveUpload,
      getUpdateUploadProgress,
    } = setup();
    const publishAttempt = dispatch(attemptToPublish());
    await waitUntilPhase('uploading');
    const updateUploadProgress = getUpdateUploadProgress();

    expect(getUploadProgress(getState())).toEqual(0);

    updateUploadProgress(0.2);
    expect(getUploadProgress(getState())).toEqual(0.2);

    updateUploadProgress(0.5);
    expect(getUploadProgress(getState())).toEqual(0.5);

    resolveUpload('FAKEHASH');

    expect(await publishAttempt).toEqual(true);

    expect(getUploadProgress(getState())).toEqual(0);
  });

  it('can reset after a successful upload', async function() {
    const { dispatch, getState, resolveUpload } = setup();
    const publishAttempt = dispatch(attemptToPublish());
    resolveUpload('FAKEHASH');
    expect(getUploadGeneration(getState())).toEqual(0);

    expect(await publishAttempt).toEqual(true);

    expect(getUploadPhase(getState())).toEqual('uploaded');
    expect(getUploadGeneration(getState())).toEqual(1);
    dispatch(resetUploadState());
    expect(getUploadPhase(getState())).toEqual('local');
  });

  it('can abort an upload', async function() {
    const { dispatch, getState } = setup();
    const publishAttempt = dispatch(attemptToPublish());
    expect(getUploadGeneration(getState())).toEqual(0);
    dispatch(abortUpload());
    expect(getUploadGeneration(getState())).toEqual(1);

    expect(await publishAttempt).toEqual(false);
    expect(getUploadPhase(getState())).toEqual('local');
  });

  it('obeys the generational value, and ignores stale uploads', async function() {
    const {
      dispatch,
      getState,
      resolveUpload,
      waitUntilPhase,
      abortFunction,
    } = setup();
    // Kick off a download.
    const promise = dispatch(attemptToPublish());
    expect(getUploadGeneration(getState())).toEqual(0);

    // Wait until it finishes compressing, and starts uploading.
    await waitUntilPhase('uploading');

    // Abort the download.
    dispatch(abortUpload());

    // Make sure the abort function was called.
    expect(abortFunction).toHaveBeenCalled();
    expect(getUploadGeneration(getState())).toEqual(1);

    // Resolve the previous upload.
    resolveUpload('FAKEHASH');
    await promise;

    // Make sure that the attemptToPublish workflow doesn't continue to the
    // uploaded state.
    expect(getUploadPhase(getState())).toEqual('local');
  });

  it('can revert back to the original state', async function() {
    // This function tests the original state with the trivial operation of
    // testing on the current tab.
    const { dispatch, getState, resolveUpload } = setup();

    const originalTab = 'flame-graph';
    const changedTab = 'stack-chart';

    // Check which tab we start on.
    dispatch(changeSelectedTab(originalTab));
    expect(getSelectedTab(getState())).toEqual(originalTab);

    // Ensure we are sanitizing something.
    const sharingOptions = getCheckedSharingOptions(getState());
    if (sharingOptions.includeUrls) {
      dispatch(toggleCheckedSharingOptions('includeUrls'));
    }

    // Now upload.
    const publishAttempt = dispatch(attemptToPublish());
    resolveUpload('FAKEHASH');
    expect(await publishAttempt).toEqual(true);

    // Check that we are still on this tab.
    expect(getSelectedTab(getState())).toEqual(originalTab);

    // Now change it to another tab
    dispatch(changeSelectedTab(changedTab));
    expect(getSelectedTab(getState())).toEqual(changedTab);

    // Revert the profile.
    await dispatch(revertToPrePublishedState());

    // The original state should be restored.
    expect(getSelectedTab(getState())).toEqual(originalTab);
  });

  describe('with zip files', function() {
    const setupZipFileTests = async () => {
      const { store } = await storeWithZipFile([
        'profile1.json',
        'profile2.json',
      ]);
      return setupFakeUploadsWithStore(store);
    };

    it('removes the zip viewer and only shows the profiler after upload', async function() {
      const { dispatch, getState, resolveUpload } = await setupZipFileTests();

      // Load and view a ZIP file.
      await dispatch(viewProfileFromPathInZipFile('profile1.json'));

      // Check that the initial state makes sense for viewing a zip file.
      expect(getHasZipFile(getState())).toEqual(true);
      expect(getDataSource(getState())).toEqual('from-file');

      // Upload the profile.
      const publishAttempt = dispatch(attemptToPublish());
      resolveUpload('FAKEHASH');
      expect(await publishAttempt).toEqual(true);

      // Now check that we are reporting as being a public single profile.
      expect(getHasZipFile(getState())).toEqual(false);
      expect(getDataSource(getState())).toEqual('public');
    });

    it('can revert viewing the original zip file state after publishing', async function() {
      const { dispatch, getState, resolveUpload } = await setupZipFileTests();

      // Load and view a ZIP file.
      await dispatch(viewProfileFromPathInZipFile('profile1.json'));

      // Now upload.
      const publishAttempt = dispatch(attemptToPublish());
      resolveUpload('FAKEHASH');
      expect(await publishAttempt).toEqual(true);

      // Now check that we are reporting as being a public single profile.
      expect(getHasZipFile(getState())).toEqual(false);
      expect(getDataSource(getState())).toEqual('public');
      expect(getProfileName(getState())).toEqual('profile1.json');

      // Revert the profile.
      await dispatch(revertToPrePublishedState());

      // Now check that we have reverted to the original profile.
      expect(getHasZipFile(getState())).toEqual(true);
      expect(getDataSource(getState())).toEqual('from-file');

      // Repeat this test with the other profile in the ZIP file.
      dispatch(returnToZipFileList());
      await dispatch(viewProfileFromPathInZipFile('profile2.json'));

      // Now upload the SECOND profile.
      const publishAttempt2 = dispatch(attemptToPublish());
      resolveUpload('FAKEHASH');
      expect(await publishAttempt2).toEqual(true);

      // For the second profile, check that we are reporting as being a public
      // single profile.
      expect(getHasZipFile(getState())).toEqual(false);
      expect(getDataSource(getState())).toEqual('public');
      expect(getProfileName(getState())).toEqual('profile2.json');
    });
  });
});
