import asyncio
from controller import Computer


def test_bot_input_during_human_control_has_visible_error(tmp_path):
    async def scenario():
        computer = Computer(tmp_path)
        computer.mode = 'human'
        computer.launch({'tool': 'click', 'x': 10, 'y': 10})
        await computer.task
        assert not computer.busy
        assert computer.messages[-1]['role'] == 'error'
        assert 'Return control' in computer.messages[-1]['text']
        computer.stopped = True
        computer.launch({'tool': 'list_files'})
        await computer.task
        assert computer.messages[-1]['role'] == 'error'
        assert 'stopped' in computer.messages[-1]['text']
    asyncio.run(scenario())
