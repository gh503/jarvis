import { createHash } from 'node:crypto'
import type { ToolDefinition } from '../tools.ts'

const precision = 'IEEE-754 JavaScript number, about 15–17 significant digits; rounding errors possible; no financial precision guarantee.'
const finite = (n:number):number => { if(!Number.isFinite(n))throw new Error('Non-finite number or arithmetic overflow'); return n }
function parse(input:string):number {
  if(typeof input!=='string'||!input.trim()||input.length>512)throw new Error('Expression must contain 1–512 characters')
  let at=0, operations=0
  const space=()=>{while(at<input.length&&/\s/.test(input[at]!))at++}
  const op=()=>{if(++operations>128)throw new Error('Operation limit is 128')}
  const expression=(minimum=0,depth=0):number=>{
    if(depth>32)throw new Error('Nesting limit is 32')
    space();let value:number
    const first=input[at]
    if(first==='+'||first==='-'){at++;op();const n=expression(3,depth+1);value=first==='-'?-n:n}
    else if(first==='('){at++;value=expression(0,depth+1);space();if(input[at++]!==')')throw new Error('Missing closing parenthesis')}
    else {const match=/^(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?/.exec(input.slice(at));if(!match)throw new Error('Expected a number or parenthesis');at+=match[0].length;value=finite(Number(match[0]))}
    while(true){space();const operator=input[at]??'';const precedence=operator==='+'||operator==='-'?1:operator==='*'||operator==='/'||operator==='%'?2:operator==='^'?3:-1
      if(precedence<minimum)break
      at++;op();const right=expression(operator==='^'?precedence:precedence+1,depth+1)
      if((operator==='/'||operator==='%')&&right===0)throw new Error('Division by zero')
      value=finite(operator==='+'?value+right:operator==='-'?value-right:operator==='*'?value*right:operator==='/'?value/right:operator==='%'?value%right:value**right)
    }
    return finite(value)
  }
  const result=expression();space();if(at!==input.length)throw new Error('Unexpected expression token');return result
}
type Unit={dimension:string;scale:number;offset?:number}
const units:Record<string,Unit>={}
for(const [dimension, entries] of Object.entries({length:{m:1,km:1000,cm:.01,mm:.001,in:.0254,ft:.3048,yd:.9144,mi:1609.344},mass:{kg:1,g:.001,mg:.000001,lb:.45359237,oz:.028349523125},time:{ms:.001,s:1,min:60,h:3600,day:86400,week:604800},storage:{B:1,KB:1000,MB:1e6,GB:1e9,TB:1e12,KiB:1024,MiB:1048576,GiB:1073741824,TiB:1099511627776}})){
  for(const [name,scale] of Object.entries(entries))units[name]={dimension,scale}
}
units.K={dimension:'temperature',scale:1};units.C={dimension:'temperature',scale:1,offset:273.15};units.F={dimension:'temperature',scale:5/9,offset:273.15-32*5/9}
export function calculate(args:{expression:string;fromUnit?:string;toUnit?:string}) {
  const value=parse(args.expression)
  if(args.fromUnit===undefined&&args.toUnit===undefined)return {result:value,precision}
  const from=typeof args.fromUnit==='string'&&Object.hasOwn(units,args.fromUnit)?units[args.fromUnit]:undefined,to=typeof args.toUnit==='string'&&Object.hasOwn(units,args.toUnit)?units[args.toUnit]:undefined
  if(!from||!to||from.dimension!==to.dimension)throw new Error('Both units must be whitelisted and have matching dimensions')
  const base=finite(finite(value*from.scale)+(from.offset??0));const result=finite(finite(base-(to.offset??0))/to.scale)
  return {result,fromUnit:args.fromUnit,toUnit:args.toUnit,dimension:from.dimension,precision}
}
export function strictInstant(input:string):Date {
  if(typeof input!=='string')throw new Error('Expected ISO instant with explicit offset')
  const m=/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|([+-])(\d{2}):(\d{2}))$/.exec(input)
  if(!m)throw new Error('Expected ISO instant with seconds and explicit Z or ±HH:mm offset')
  const year=Number(m[1]),month=Number(m[2]),day=Number(m[3]),hour=Number(m[4]),minute=Number(m[5]),second=Number(m[6])
  const leap=year%4===0&&(year%100!==0||year%400===0),days=[31,leap?29:28,31,30,31,30,31,31,30,31,30,31]
  if(month<1||month>12||day<1||day>days[month-1]!||hour>23||minute>59||second>59||Number(m[10]??0)>23||Number(m[11]??0)>59)throw new Error('Invalid calendar date or offset')
  const date=new Date(input);finite(date.getTime());return date
}
export function timeConvert(args:{instant:string;timeZone:string}){
  const date=strictInstant(args.instant),zone=args.timeZone
  if(typeof zone!=='string'||zone.length>100||!zone||/^[+-]/.test(zone))throw new Error('Expected an IANA time zone')
  const formatter=new Intl.DateTimeFormat('en-US',{timeZone:zone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23',weekday:'long',era:'short'})
  const parts=Object.fromEntries(formatter.formatToParts(date).map(p=>[p.type,p.value]))
  const year=parts.era==='BC'?1-Number(parts.year):Number(parts.year)
  if(year<0||year>9999)throw new Error('Target calendar year outside supported ISO range')
  const wall=new Date(0);wall.setUTCFullYear(year,Number(parts.month)-1,Number(parts.day));wall.setUTCHours(Number(parts.hour),Number(parts.minute),Number(parts.second),date.getUTCMilliseconds())
  const offsetSeconds=(wall.getTime()-date.getTime())/1000
  if(offsetSeconds%60!==0)throw new Error('Historical sub-minute zone offset is unsupported')
  const minutes=Math.abs(offsetSeconds/60),pad=(n:number)=>String(n).padStart(2,'0')
  const offset=`${offsetSeconds<0?'-':'+'}${pad(Math.floor(minutes/60))}:${pad(minutes%60)}`
  const localISO=`${String(year).padStart(4,'0')}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}.${String(date.getUTCMilliseconds()).padStart(3,'0')}${offset}`
  return {iso:date.toISOString(),utc:date.toISOString(),localISO,timeZone:formatter.resolvedOptions().timeZone,offset,weekday:parts.weekday,local:`${parts.weekday}, ${localISO} (${zone})`}
}
export function calculationTools():ToolDefinition[]{
  const make=(name:string,description:string,properties:Record<string,unknown>,required:string[],run:(args:any)=>unknown):ToolDefinition=>({
    name,description,parameters:{type:'object',properties,required,additionalProperties:false},definitionHash:createHash('sha256').update(JSON.stringify(['calculation-v2',name,properties])).digest('hex'),usage:'shared',permission:'allow',effect:'read',destination:'local',
    async execute(args,context){try{context.signal.throwIfAborted();if(Object.keys(args).some(k=>!Object.hasOwn(properties,k)))throw new Error('Unknown argument');return {content:JSON.stringify(run(args))}}catch(error){return {content:error instanceof Error?error.message:String(error),isError:true}}},
  })
  return [
    make('calculate','Safely calculate + - * / % ^ and parentheses. Floating point, no financial precision guarantee. Optional compatible unit conversion.',{expression:{type:'string',minLength:1,maxLength:512},fromUnit:{type:'string',enum:Object.keys(units)},toUnit:{type:'string',enum:Object.keys(units)}},['expression'],calculate),
    make('time_convert','Convert a strict ISO instant with explicit offset to an IANA time zone, with weekday and UTC.',{instant:{type:'string'},timeZone:{type:'string'}},['instant','timeZone'],timeConvert),
    make('time_difference','Elapsed time between strict ISO instants; days are fixed 24-hour periods.',{from:{type:'string'},to:{type:'string'}},['from','to'],args=>{const milliseconds=strictInstant(args.to).getTime()-strictInstant(args.from).getTime();return {milliseconds,seconds:milliseconds/1000,days:milliseconds/86400000,dayDefinition:'24 hours'}}),
  ]
}
