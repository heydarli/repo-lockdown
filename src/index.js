const core = require('@actions/core');
const github = require('@actions/github');
const uniqBy = require('lodash.uniqby');

const schema = require('./schema');

async function run() {
  try {
    console.log(`Starting as [${github.context.eventName}]`);
    const config = getConfig();
    const client = github.getOctokit(config['github-token']);

    const app = new App(config, client);
    if (github.context.eventName === 'schedule') {
      await app.processBacklog();
    } else {
      await app.processNewThread();
    }
  } catch (err) {
    core.setFailed(err);
  }
}

class App {
  constructor(config, client) {
    this.config = config;
    this.client = client;
  }

  async processBacklog() {
    console.log('Processing backlog...');
    const processOnly = this.config['process-only'];
    const threadTypes = processOnly ? [processOnly] : ['pr'];

    let threadsFound = false;

    for (const threadType of threadTypes) {
      const threads = await this.lockdown({threadType});

      if (threads.length) {
        threadsFound = true;
        console.log(`Setting output (${threadType}s)`);
        core.setOutput(`${threadType}s`, JSON.stringify(threads));
      }
    }

    if (!threadsFound) {
      core.warning(
        'All issues and pull requests have been processed. Remove the `schedule` event from the workflow file to avoid unnecessary workflow runs in the future.'
      );
    }
  }

  async processNewThread() {
    const threadType = github.context.eventName === 'issues' ? 'issue' : 'pr';

    const processOnly = this.config['process-only'];
    if (processOnly && processOnly !== threadType) {
      return;
    }

    const threads = await this.lockdown({
      threadType,
      threadData:
        github.context.payload.issue || github.context.payload.pull_request
    });

    if (threads.length) {
      console.log(`Setting output (${threadType}s)`);
      core.setOutput(`${threadType}s`, JSON.stringify(threads));
    }
  }

  async lockdown({threadType = '', threadData = null} = {}) {
    const repo = github.context.repo;

    const labels = this.config[`${threadType}-labels`];
    const comment = this.config[`${threadType}-comment`];
    const skipClosedComment = this.config[`skip-closed-${threadType}-comment`];
    const close = this.config[`close-${threadType}`];
    const lock = this.config[`lock-${threadType}`];
    const lockReason = this.config[`${threadType}-lock-reason`];
    const freezePr = this.config[`freeze-pr`]; // config to freeze PRs
    const freezeStatus = this.config[`freeze-status`]; // success | failure

    const processedThreads = [];

    if (threadData) {
      const excludeCreatedBefore =
        this.config[`exclude-${threadType}-created-before`];
      if (excludeCreatedBefore) {
        const created = new Date(threadData.created_at);
        if (created.getTime() < excludeCreatedBefore.getTime()) {
          return processedThreads;
        }
      }

      const excludeLabels = this.config[`exclude-${threadType}-labels`];
      if (excludeLabels) {
        const labels = threadData.labels.map(label => label.name);
        for (const label of excludeLabels) {
          if (labels.includes(label)) {
            return processedThreads;
          }
        }
      }
    }

    const threads = threadData
      ? [threadData]
      : await this.searchBacklog(threadType);

    console.log(`Found ${threads.length} open PRs`);

    for (const thread of threads) {
      const issue = {...repo, issue_number: thread.number};

      if (comment && (thread.state === 'open' || !skipClosedComment)) {
        console.log(`Commenting (${threadType}: ${thread.number})`);

        await this.ensureUnlock(
          issue,
          {active: thread.locked, reason: thread.active_lock_reason},
          () => this.client.rest.issues.createComment({...issue, body: comment})
        );
      }

      if (labels) {
        console.log(`Labeling (${threadType}: ${thread.number})`);
        await this.client.rest.issues.addLabels({
          ...issue,
          labels
        });
      }

      if (close && thread.state === 'open') {
        console.log(`Closing (${threadType}: ${thread.number})`);
        await this.client.rest.issues.update({...issue, state: 'closed'});
      }

      if (lock && !thread.locked) {
        console.log(`Locking (${threadType}: ${thread.number})`);
        let params;
        if (lockReason) {
          params = {
            ...issue,
            lock_reason: lockReason,
            headers: {
              accept: 'application/vnd.github.sailor-v-preview+json'
            }
          };
        } else {
          params = issue;
        }
        await this.client.rest.issues.lock(params);
      }

      if (freezePr && thread.state === 'open') {
        const workflow_url = `${process.env['GITHUB_SERVER_URL']}/${process.env['GITHUB_REPOSITORY']}/actions/runs/${process.env['GITHUB_RUN_ID']}`;

        console.log(`Freezing PR#${thread.number}`);
        
        const pull_details = await this.client.rest.pulls.get({
          ...github.context.repo,
          pull_number: thread.number
        });

        console.log(JSON.stringify(pull_details.data.head));

        const sha = pull_details.data.head.sha;
        await this.client.rest.repos.createCommitStatus({
          ...issue,
          sha,
          state: freezeStatus,
          context: 'PR Freezer Status',
          target_url: workflow_url,
          description: 'PR is frozen'
        });
      }

      processedThreads.push({...repo, number: thread.number});
    }

    return processedThreads;
  }

  async searchBacklog(threadType) {
    const {owner, repo} = github.context.repo;
    let query = `repo:${owner}/${repo} is:${threadType}`;

    const excludeCreatedBefore =
      this.config[`exclude-${threadType}-created-before`];
    if (excludeCreatedBefore) {
      query += ` created:>${this.getISOTimestamp(excludeCreatedBefore)}`;
    }

    const excludeLabels = this.config[`exclude-${threadType}-labels`];
    if (excludeLabels) {
      const queryPart = excludeLabels
        .map(label => `-label:"${label}"`)
        .join(' ');
      query += ` ${queryPart}`;
    }

    console.log(`Searching (${threadType}s)`);

    const results = [];

    const close = this.config[`close-${threadType}`];
    if (close) {
      const openIssues = (
        await this.client.rest.search.issuesAndPullRequests({
          q: query + ' is:open',
          sort: 'updated',
          order: 'desc',
          per_page: 50,
          headers: {
            Accept: 'application/vnd.github.sailor-v-preview+json'
          }
        })
      ).data.items;

      // results may include closed issues
      results.push(...openIssues.filter(issue => issue.state === 'open'));
    }

    const lock = this.config[`lock-${threadType}`];
    if (lock) {
      const unlockedIssues = (
        await this.client.rest.search.issuesAndPullRequests({
          q: query + ' is:unlocked',
          sort: 'updated',
          order: 'desc',
          per_page: 50
        })
      ).data.items;

      // results may include locked issues
      results.push(...unlockedIssues.filter(issue => !issue.locked));
    }

    return uniqBy(results, 'number').slice(0, 50);
  }

  async ensureUnlock(issue, lock, action) {
    if (lock.active) {
      if (!lock.hasOwnProperty('reason')) {
        const {data: issueData} = await this.client.rest.issues.get({
          ...issue,
          headers: {
            Accept: 'application/vnd.github.sailor-v-preview+json'
          }
        });
        lock.reason = issueData.active_lock_reason;
      }
      await this.client.rest.issues.unlock(issue);
      await action();
      if (lock.reason) {
        issue = {
          ...issue,
          lock_reason: lock.reason,
          headers: {
            Accept: 'application/vnd.github.sailor-v-preview+json'
          }
        };
      }
      await this.client.rest.issues.lock(issue);
    } else {
      await action();
    }
  }

  getISOTimestamp(date) {
    return date.toISOString().split('.')[0] + 'Z';
  }
}

function getConfig() {
  const input = Object.fromEntries(
    Object.keys(schema.describe().keys).map(item => [item, core.getInput(item)])
  );

  const {error, value} = schema.validate(input, {abortEarly: false});
  if (error) {
    throw error;
  }

  return value;

  // return {
  //   'freeze-pr': true,
  //   'freeze-status': core.getInput('freeze-status'),
  //   'github-token': core.getInput('freeze-status'),
  // };
}

run();
