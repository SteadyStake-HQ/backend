require('dotenv/config');
const { createPublicClient, http, parseAbiItem } = require('viem');
const { baseSepolia } = require('viem/chains');
const vault = '0x6457b147a647426edd4bcdbd5de534cb15e05f2a';
const client = createPublicClient({ chain: baseSepolia, transport: http('https://sepolia.base.org') });
const ev = parseAbiItem('event ScheduleCreated(address indexed user, uint256 indexed scheduleId, address targetToken, uint8 frequency, uint256 amountPerInterval)');
const abi = [
  {type:'function',name:'getEnrolledScheduleIds',inputs:[{name:'u',type:'address'}],outputs:[{type:'uint256[]'}],stateMutability:'view'},
  {type:'function',name:'getActiveSchedules',inputs:[{name:'u',type:'address'}],outputs:[{type:'uint256[]'}],stateMutability:'view'},
  {type:'function',name:'getReadyScheduleIds',inputs:[{name:'u',type:'address'}],outputs:[{type:'uint256[]'}],stateMutability:'view'},
];
async function info(u){
  const out={};
  for(const fn of ['getActiveSchedules','getEnrolledScheduleIds','getReadyScheduleIds']){
    try{ out[fn]=(await client.readContract({address:vault,abi,functionName:fn,args:[u]})).map(x=>x.toString()); }
    catch(e){ out[fn]='ERR:'+(e.shortMessage||e.message||'').slice(0,50); }
  }
  return out;
}
(async () => {
  const latest = await client.getBlockNumber();
  const chunk = 900n; const span = 150000n; const start = latest - span;
  const users = new Map();
  for (let from = start; from <= latest; from += chunk + 1n) {
    const to = from + chunk > latest ? latest : from + chunk;
    try {
      const logs = await client.getLogs({ address: vault, event: ev, fromBlock: from, toBlock: to });
      for (const l of logs) {
        const u=l.args.user.toLowerCase();
        if(!users.has(u)) users.set(u,[]);
        users.get(u).push({sid:l.args.scheduleId.toString(),blk:l.blockNumber.toString()});
      }
    } catch(e){ /* skip */ }
  }
  console.log('latest', latest.toString(), 'scanned last', span.toString(), 'blocks');
  console.log('creators found:', users.size);
  for (const [u, evs] of users) {
    console.log('\nUSER', u, 'created scheduleIds', evs.map(e=>e.sid).join(','), 'lastBlock', evs[evs.length-1].blk);
    console.log('  onchain', JSON.stringify(await info(u)));
  }
  // Also check the known March address explicitly
  const known='0x1bf1fdc063df1239a9407767c5be36e746104294';
  if(!users.has(known)){ console.log('\nKNOWN(March)', known); console.log('  onchain', JSON.stringify(await info(known))); }
})().catch(e => console.error('FATAL', e.shortMessage||e.message||e));
