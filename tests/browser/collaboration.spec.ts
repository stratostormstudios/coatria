import {test,expect,type BrowserContext} from '@playwright/test';

test('two coworkers join by invitation, exchange chat, review work and connect a real agent token',async({browser,baseURL})=>{
  test.skip(!baseURL||!['localhost','127.0.0.1'].includes(new URL(baseURL).hostname),'Local service fixtures only.');
  const origin=baseURL!,suffix=Date.now().toString(36),owner=await browser.newContext(),worker=await browser.newContext();
  const errors:string[]=[];
  async function post(context:BrowserContext,path:string,data:unknown,method='POST') {
    const response=await context.request.fetch(origin+path,{method,headers:{Origin:origin},data});
    expect(response.ok(),`${method} ${path}: ${await response.text()}`).toBeTruthy();return response.json();
  }
  try{
    const ownerSession=await post(owner,'/api/auth/signup',{name:'Morgan QA',email:`morgan-${suffix}@example.invalid`,password:`Coatria collaboration ${suffix}`});
    const workerSession=await post(worker,'/api/auth/signup',{name:'Sam QA',email:`sam-${suffix}@example.invalid`,password:`Coatria collaboration ${suffix}`});
    const company=(await post(owner,'/api/companies',{name:'Two people, one place',slug:`team-${suffix}`,template:'studio'})).company;
    const a=await owner.newPage(),b=await worker.newPage();for(const p of[a,b])p.on('pageerror',e=>errors.push(e.message));
    await a.goto(origin+'/#people');
    await a.getByRole('button',{name:'Invite a teammate',exact:true}).click();
    await a.getByRole('button',{name:'Create invitation',exact:true}).click();
    const link=await a.getByRole('textbox',{name:'Invitation link',exact:true}).inputValue();
    await a.getByRole('button',{name:'Close dialog',exact:true}).click();
    await b.goto(link);
    await b.getByRole('button',{name:'Join the workplace',exact:true}).click();
    await expect(b.getByRole('heading',{name:'Welcome in, Sam.',exact:true})).toBeVisible();
    await a.getByRole('button',{name:'Conversations',exact:true}).click();
    await b.getByRole('button',{name:'Conversations',exact:true}).click();
    const message='Our first shared conversation — <script>plain text</script>';
    await a.getByLabel('Your message',{exact:true}).fill(message);
    await a.getByRole('button',{name:'Send',exact:true}).click();
    await expect(b.getByText(message,{exact:true})).toBeVisible();
    const task=(await post(owner,`/api/companies/${company.id}/tasks`,{title:'Verify the shared office',description:'Inspect the floor and submit an outcome.',assigneeId:workerSession.user.id})).task;
    await b.getByRole('button',{name:'Work board',exact:true}).click();
    await b.getByRole('button').filter({has:b.getByRole('heading',{name:task.title,exact:true})}).click();
    await b.getByRole('dialog').getByRole('combobox',{name:'Status',exact:true}).selectOption('review');
    await b.getByLabel('Contribution link',{exact:false}).fill('https://example.com/coatria-test-result');
    await b.getByRole('button',{name:'Save task updates',exact:true}).click();
    await expect(b.getByRole('dialog').getByText('In review',{exact:true})).toBeVisible();
    await a.getByRole('button',{name:/^Work board/}).click();
    await a.getByRole('button').filter({has:a.getByRole('heading',{name:task.title,exact:true})}).click();
    await a.getByRole('button',{name:'Review and accept',exact:true}).click();
    await a.getByLabel('Review decision',{exact:true}).fill('Inspected the delivered outcome and verified the office behavior.');
    await a.getByRole('button',{name:'Accept contribution',exact:true}).click();
    await expect(a.getByText('Accepted by an independent reviewer',{exact:true})).toBeVisible();
    await a.getByRole('button',{name:'Close dialog',exact:true}).click();
    await a.getByRole('button',{name:'Your agents',exact:true}).click();
    await a.getByRole('button',{name:'Connect an agent',exact:true}).click();
    await a.getByLabel('Agent name',{exact:true}).fill('Atlas QA');
    await a.getByRole('dialog').getByRole('combobox',{name:'Your harness',exact:true}).selectOption('custom');
    await a.getByRole('button',{name:'Create agent identity',exact:true}).click();
    const token=await a.getByLabel('Connection token',{exact:true}).inputValue();
    const agentWork=await owner.request.get(origin+'/api/agent/work',{headers:{Authorization:`Bearer ${token}`}});
    expect(agentWork.ok()).toBeTruthy();const work=await agentWork.json();expect(work.agent.name).toBe('Atlas QA');expect(work).not.toHaveProperty('skills');
    await a.getByRole('button',{name:'Close dialog',exact:true}).click();
    await expect(a.getByText('Connected',{exact:true})).toBeVisible();
    await a.getByRole('button',{name:'The office',exact:true}).click();
    await b.getByRole('button',{name:'Close dialog',exact:true}).click();
    await b.getByRole('button',{name:'The office',exact:true}).click();
    await expect(a.locator('canvas')).toBeVisible();
    await expect(a.getByText('Sam QA',{exact:true}).first()).toBeVisible();
    await a.screenshot({path:'test-results/coatria-shared-office.png',fullPage:true});
    expect(errors).toEqual([]);
    expect(ownerSession.user.id).not.toBe(workerSession.user.id);
  }finally{await owner.close();await worker.close();}
});
