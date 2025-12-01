import { useMutation, useQuery } from 'convex/react';
import { api } from '../../convex/_generated/api';
import Button from './buttons/Button';

export default function FreezeButton() {
  const stopAllowed = useQuery(api.testing.stopAllowed) ?? false;
  const defaultWorld = useQuery(api.world.defaultWorldStatus);

  const frozen = defaultWorld?.status === 'stoppedByDeveloper';

  const unfreeze = useMutation(api.testing.resume);
  const freeze = useMutation(api.testing.stop);

  const flipSwitch = async () => {
    if (!defaultWorld?.worldId) return;
    if (frozen) {
      console.log('Unfreezing');
      await unfreeze({ worldId: defaultWorld.worldId });
    } else {
      console.log('Freezing');
      await freeze({ worldId: defaultWorld.worldId });
    }
  };

  return !stopAllowed ? null : (
    <>
      <Button
        onClick={flipSwitch}
        className="hidden lg:block"
        title="When freezing a world, the agents will take some time to stop what they are doing before they become frozen. "
        imgUrl="/assets/star.svg"
      >
        {frozen ? 'Unfreeze' : 'Freeze'}
      </Button>
    </>
  );
}
