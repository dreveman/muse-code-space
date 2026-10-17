import{test}from'node:test';import assert from'node:assert/strict';import{readFileSync}from'node:fs';import{toolPresentation}from'./toolPresentation.ts';
const root='/tmp/agent';
const item=(tool,status='completed',args=null,output=null,extra={})=>({label:`${tool} · old label`,workspaceRoot:root,running:status==='inProgress',details:{tool,status,args,output,failureReason:null,truncated:false,outputRef:null,patchRef:null,patchSummary:null,...extra}});

test('read and edit exact tool ids get tense, safe paths, and verified change counts',()=>{
 assert.deepEqual(toolPresentation(item('read_file','inProgress',JSON.stringify({path:'/tmp/agent/src/test.rs'}))),{adapterId:'read',name:'Reading',detail:'src/test.rs',view:'file',showDuration:false,metric:null,command:null,emphasizeName:false});
 assert.equal(toolPresentation(item('read_file','completed',JSON.stringify({path:'src/test.rs'}))).name,'Read');
 const edit=item('edit_file','completed',JSON.stringify({path:'test.rs',find:'SECRET',replace:'NEW'}),null,{patchSummary:{files:1,added:2,removed:1}});
 assert.deepEqual(toolPresentation(edit),{adapterId:'edit',name:'Edited',detail:'test.rs',view:'diff',showDuration:false,metric:null,command:null,emphasizeName:false});
 assert.equal(toolPresentation({...edit,details:{...edit.details,status:'failed',failureReason:'bad edit'}}).name,'Edit failed');
 assert.equal(toolPresentation(item('edit_file','inProgress',JSON.stringify({path:'test.rs'}))).name,'Editing');
 assert.equal(toolPresentation(item('edit_file','inProgress')).showDuration,false,'the edit adapter hides even a live timer');
 assert.equal(toolPresentation(item('edit')).showDuration,false,'explicit edit alias uses the same rule');
});

test('Bash and code-space messaging get named adapters; unknown tools remain visible',()=>{
 assert.equal(toolPresentation(item('mcp__code_space__send_message','inProgress')).name,'Sending message');
 assert.equal(toolPresentation(item('mcp__code_space__send_message')).name,'Sent message');
 const undelivered=toolPresentation(item('mcp__code_space__send_message','completed',JSON.stringify({to:'pip',text:'hello'}),'Not delivered: offline'));
 assert.equal(undelivered.name,'Message failed');assert.equal(undelivered.emphasizeName,true,'MCP isError output stays visibly failed');
 assert.equal(toolPresentation(item('mcp__code_space__list_agents')).name,'Listed agents');
 assert.equal(toolPresentation(item('mcp__code_space__list_agents')).view,'agent-list');
 assert.equal(toolPresentation(item('mcp__code_space__list_agents')).showDuration,false,'instant directory lookups do not need a final time');
 assert.equal(toolPresentation(item('mcp__code_space__list_agents','inProgress')).name,'Listing agents');
 const bash=item('bash','inProgress',JSON.stringify({command:'printf TEST',description:'Check output'}));
 assert.deepEqual(toolPresentation(bash),{adapterId:'bash',name:'Running bash',detail:'Check output',view:'command',showDuration:true,metric:null,command:'printf TEST',emphasizeName:false});
 assert.equal(toolPresentation({...bash,running:false,details:{...bash.details,status:'completed'}}).name,'Ran bash');
 const badExit=toolPresentation(item('bash','failed',JSON.stringify({command:'exit 7',description:'Check failure'}),null,{failureReason:'process exited with status 7'}));
 assert.equal(badExit.name,'Ran bash');assert.equal(badExit.emphasizeName,true,'nonzero Bash exit colors only the name');
 assert.equal(toolPresentation(item('bash','completed',null,null,{failureReason:'process exited with status 0'})).emphasizeName,false);
 assert.equal(toolPresentation(item('bash','completed','{broken')).command,null,'malformed arguments use the raw fallback');
 assert.equal(toolPresentation(item('mystery','inProgress')).name,'Running mystery');
 assert.equal(toolPresentation(item('mystery')).name,'Ran mystery');
 assert.equal(toolPresentation(item('mystery')).showDuration,true,'unknown tools retain timing by default');
 assert.equal(toolPresentation(item('mystery','failed',null,null,{failureReason:'error'})).name,'Failed mystery');
 assert.equal(toolPresentation(item('mcp__code_space__send_message')).showDuration,true);
 assert.equal(toolPresentation(item('read_file','completed','{broken')).detail,null);
 assert.equal(toolPresentation(item('read_file','completed',JSON.stringify({path:'https://secret/token'}))).detail,null);
 assert.equal(toolPresentation(item('read_file','completed',JSON.stringify({path:'/Users/realname/private.key'}))).detail,'private.key');
 assert.equal(toolPresentation({label:'bash · $ old cmd',details:null,running:false,workspaceRoot:root}).name,'bash');
 assert.deepEqual(toolPresentation(item('bash','completed',null,'old result',{tool:null})),{adapterId:'legacy',name:'bash',detail:'old label',view:'plain',showDuration:true,metric:null,command:null,emphasizeName:false},'old JSON lacking a tool ID uses its persisted label');
});

test('every running tool gets a spinner; only finished opted-in tools show a time',()=>{
 const app=readFileSync(new URL('./App.tsx',import.meta.url),'utf8');
 const css=readFileSync(new URL('./theme.css',import.meta.url),'utf8');
 assert.ok(app.includes('const running = finishedAt === null && (details?.status === "inProgress" || startedAt !== null)'), 'live state is independent of whether duration is shown');
 assert.ok(app.includes('running ? (\n          <span className="working-spinner tool-run-spinner" aria-hidden="true" />'), 'all live tools spin, including edits');
 assert.ok(app.includes('presentation.showDuration && elapsed !== null ? ('), 'time is an opt-in check only for the terminal branch');
 assert.ok(app.includes('formatToolDuration(elapsed, false)'), 'finished times stay frozen');
 assert.ok(/\.working-spinner\.tool-run-spinner\s*\{[^}]*width:\s*11px/.test(css), 'smaller spinner suits the compact row');
 assert.ok(app.includes('presentation.view === "command" && !showRawToolOutput && presentation.command !== null'), 'normal Bash expansion shows the command, not result text');
 assert.ok(app.includes('presentation.emphasizeName ? " tool-name-error" : ""') && /\.tool-name-error\s*\{[^}]*color:\s*var\(--terminal-error\)/.test(css), 'nonzero Bash exits color only the name red');
});

test('GitHub tools get named adapters with details and failed tense from the output marker',()=>{
 const create=toolPresentation(item('mcp__code_space__github_create_pr','completed',JSON.stringify({title:'Fix the thing'}),'Created PR #7 Fix the thing'));
 assert.equal(create.name,'Created Pull Request');assert.equal(create.detail,'Fix the thing');assert.equal(create.view,'plain');
 assert.equal(toolPresentation(item('mcp__code_space__github_create_pr','inProgress',JSON.stringify({title:'Fix the thing'}))).name,'Creating Pull Request');
 const createFailed=toolPresentation(item('mcp__code_space__github_create_pr','completed',JSON.stringify({title:'Fix the thing'}),'Failed: GitHub said: Validation Failed'));
 assert.equal(createFailed.name,'Creating Pull Request failed','MCP isError output with the Failed: marker reads as failed even when status completed');
 assert.deepEqual(toolPresentation(item('mcp__code_space__github_pr_status','completed',JSON.stringify({number:6,repo:'o/r'}))),{adapterId:'github-pr-status',name:'Checked Pull Request',detail:'#6',view:'plain',showDuration:false,metric:null,command:null,emphasizeName:false});
 assert.equal(toolPresentation(item('mcp__code_space__github_pr_status','inProgress',JSON.stringify({number:6}))).name,'Checking Pull Request');
 assert.equal(toolPresentation(item('mcp__code_space__github_list_prs','completed',JSON.stringify({repo:'dreveman/muse-code-space'}))).name,'Listed Pull Requests');
 assert.equal(toolPresentation(item('mcp__code_space__github_list_prs','completed',JSON.stringify({repo:'dreveman/muse-code-space'}))).detail,'dreveman/muse-code-space');
 assert.equal(toolPresentation(item('mcp__code_space__github_list_prs','inProgress')).name,'Listing Pull Requests');
 assert.equal(toolPresentation(item('mcp__code_space__github_list_prs','completed')).showDuration,false,'instant PR lookups do not need a final time');
 assert.equal(toolPresentation(item('mcp__code_space__github_list_prs','completed',JSON.stringify({state:'closed'}))).detail,'closed');
 const monitor=toolPresentation(item('mcp__code_space__github_monitor_pr','completed',JSON.stringify({action:'subscribe',pr_ids:['#6','#7']})));
 assert.equal(monitor.name,'Started monitoring');assert.equal(monitor.detail,'PR #6, PR #7');assert.equal(monitor.showDuration,false);
 assert.equal(toolPresentation(item('mcp__code_space__github_monitor_pr','inProgress',JSON.stringify({number:6}))).name,'Starting monitoring');
 assert.equal(toolPresentation(item('mcp__code_space__github_monitor_pr','inProgress',JSON.stringify({number:6}))).detail,'PR #6');
 assert.equal(toolPresentation(item('mcp__code_space__github_monitor_pr','completed',JSON.stringify({action:'unsubscribe',pr_ids:['#6']}))).name,'Stopped monitoring');
});

test('only unknown tools with valid JSON output select syntax highlighting',()=>{
 assert.equal(toolPresentation(item('mystery','completed',null,'{"ok":true}')).view,'json');
 assert.equal(toolPresentation(item('mystery','completed',null,'42')).view,'json');
 assert.equal(toolPresentation(item('mystery','completed',null,'{broken')).view,'plain');
 assert.equal(toolPresentation(item('read_file','completed',null,'{"ok":true}')).view,'file');
});
