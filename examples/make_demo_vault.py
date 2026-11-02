#!/usr/bin/env python3
"""Generate a throwaway demo vault with made-up projects, so the plugin can be tried safely.

Usage: python make_demo_vault.py <target_dir>
All names and data are fictional. Dates are relative to today so aging looks right.
"""
import json
import os
import sys
import time
from datetime import date, timedelta

target = sys.argv[1]
if os.path.exists(target) and os.listdir(target):
    raise SystemExit(f'{target} is not empty; choose a new folder')

today = date.today()


def day(n):
    return (today - timedelta(days=n)).isoformat()


def write(rel, text, age_days=0):
    path = os.path.join(target, rel)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, 'w', encoding='utf-8', newline='\n') as f:
        f.write(text)
    stamp = time.time() - age_days * 86400
    os.utime(path, (stamp, stamp))


W = '1.1-主任务/work/'
P = '1.1-主任务/personal/'
A = W + '归档/'

# (folder, [(file, age in days)])
FOLDERS = {
    W + '客户A-智能客服': [('方案草稿.md', 1), ('会议纪要.md', 2)],
    W + '客户B-数据平台': [('需求梳理.md', 3)],
    W + '客户C-联合验证': [('评审材料.md', 12)],
    W + '客户D-培训': [('大纲.md', 20)],
    W + '汇报模板': [('页面结构.md', 40)],
    W + '会议纪要': [('2026-周会.md', 2)],
    P + '知识库设计': [('规则草稿.md', 0)],
    P + '提示词手册': [('手册.md', 6)],
    P + '读书笔记': [('书单.md', 50)],
    P + '小游戏': [('想法.md', 70)],
    A + '客户E-已结项': [('总结.md', 90)],
}
for folder, files in FOLDERS.items():
    for name, age in files:
        write(f'{folder}/{name}', f'# {name[:-3]}\n\n演示内容。\n', age)

PROJECTS = {
    W + '客户A-智能客服': dict(lane='我在推', level='高', stage='方案', touched=day(1), alias='客户A',
                              node='方案初稿已完成', next='补充效益测算，周四发给对方',
                              log=[dict(d=day(9), t='第一次需求沟通'), dict(d=day(2), t='内部对齐产品能力')]),
    W + '客户B-数据平台': dict(lane='我在推', level='高', stage='梳理', touched=day(3), alias='客户B',
                              node='需求范围还没定', next='确认一期覆盖哪些数据源',
                              log=[dict(d=day(3), t='拿到样例数据')]),
    W + '客户C-联合验证': dict(lane='等别人', level='中', stage='方案', touched=day(12),
                              node='评审材料已提交', next='等对方确认首个验证场景',
                              fields={'等谁': '对方负责人'}, log=[dict(d=day(12), t='提交评审材料')]),
    W + '客户D-培训': dict(lane='等别人', level='低', stage='起步', touched=day(20),
                           node='大纲已发', next='等培训时间', fields={'等谁': '对方 HR'},
                           log=[dict(d=day(20), t='发送大纲')]),
    W + '汇报模板': dict(lane='搁置', level='低', stage='梳理', touched=day(40),
                         node='页面结构已整理', next='用一次真实汇报检验'),
    W + '客户F-意向沟通': dict(lane='我在推', level='中', stage='起步', touched=day(4), virtual=True,
                              node='刚有意向，还没建文件夹', next='约第一次沟通'),
    P + '知识库设计': dict(lane='我在推', level='高', stage='验证', touched=day(0), alias='工作台',
                           node='调度台 v0.5 已可用', next='用一周，再决定怎么调整',
                           log=[dict(d=day(0), t='今天和调度台合并')]),
    P + '提示词手册': dict(lane='我在推', level='中', stage='验证', touched=day(6),
                           node='手册已成形', next='把真实纠错写回条目'),
    P + '读书笔记': dict(lane='搁置', level='低', stage='梳理', touched=day(50),
                         node='有书单', next='挑一本开始'),
    P + '小游戏': dict(lane='搁置', level='低', stage='起步', touched=day(70),
                       node='只有想法', next='明确要做什么'),
    A + '客户E-已结项': dict(lane='归档', level='低', stage='落地', touched=day(90),
                            node='已交付', next=''),
}
store = {
    'version': 1,
    'roots': [{'path': '1.1-主任务/work', 'line': '工作'}, {'path': '1.1-主任务/personal', 'line': '个人'}],
    'archive': ['1.1-主任务/work/归档'],
    'ignore': ['1.1-主任务/work/会议纪要'],
    'projects': PROJECTS,
}
write('1.1-主任务/调度台.json', json.dumps(store, ensure_ascii=False, indent=2) + '\n', 0)

heading = f'{today.month}.{today.day}'
write('2-工作台.md', f"""{heading}

1 客户A 效益测算，今天要补完
2 工作台 再用用看
3 打印报销材料
4 想法：能不能把周会纪要自动分到项目
""", 1)

for offset, body in [(1, '客户A 约了周四\n\n整理会议纪要'), (2, '和客户B 确认样例数据\n\n读书：第三章'), (5, '提示词手册 补一条纠错')]:
    d = today - timedelta(days=offset)
    path = f'1.3-已归档/work/工作台历史/{d.strftime("%Y-%m")}.md'
    existing = ''
    full = os.path.join(target, path)
    if os.path.exists(full):
        existing = open(full, encoding='utf-8').read()
    write(path, existing + f'## {d.isoformat()}\n\n{body}\n\n', offset)

print('demo vault at', target)
