"""Unit tests for scripts/cctv_twin_pose.py (synthetic COCO-17 skeletons).

Run: /Users/risheeray/phone_detc_venv/bin/python scripts/cctv_twin_pose_test.py
"""

import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from cctv_twin_pose import (  # noqa: E402
    AnchorStabilizer, PostureSmoother, anchor_for, classify_posture, estimate_orientation,
)

HIDDEN = 0.05


def skeleton(points, default_conf=0.9):
    """points: {index: (x, y) or (x, y, conf)}; missing indices are hidden."""
    keypoints = [(0.0, 0.0)] * 17
    confs = [HIDDEN] * 17
    for index, value in points.items():
        keypoints[index] = (float(value[0]), float(value[1]))
        confs[index] = value[2] if len(value) > 2 else default_conf
    return keypoints, confs


# Torso length T = 100 px in every skeleton; frontal shoulder width >= 0.55 T.
FACE_FRONT = {0: (200, 60), 1: (210, 52), 2: (190, 52)}
SHOULDERS_FRONT = {5: (228, 100), 6: (172, 100)}

STANDING = skeleton({
    **FACE_FRONT, **SHOULDERS_FRONT,
    11: (220, 200), 12: (180, 200), 13: (222, 285), 14: (178, 285), 15: (222, 370), 16: (178, 370),
})
SEATED_SIDE = skeleton({
    0: (240, 70), 1: (232, 62),
    5: (204, 100), 6: (197, 100),
    11: (203, 200), 12: (197, 200), 13: (283, 205), 14: (277, 205), 15: (283, 292), 16: (277, 292),
})
SEATED_FRONTAL = skeleton({
    **FACE_FRONT, **SHOULDERS_FRONT,
    11: (220, 200), 12: (180, 200), 13: (225, 230), 14: (175, 230), 15: (225, 320), 16: (175, 320),
})
LEGS_HIDDEN = skeleton({**FACE_FRONT, **SHOULDERS_FRONT, 11: (220, 200), 12: (180, 200)})
LEGS_HIDDEN_NO_HIPS = skeleton({**FACE_FRONT, **SHOULDERS_FRONT})
AWAY = skeleton({
    3: (215, 70, 0.6), 4: (185, 70, 0.6),
    5: (164, 100), 6: (236, 100),
    11: (180, 200), 12: (220, 200), 13: (180, 285), 14: (220, 285),
})
CROUCHED = skeleton({
    **{0: (200, 110), 1: (210, 102), 2: (190, 102)},
    5: (236, 150), 6: (164, 150),
    11: (220, 250), 12: (180, 250), 13: (240, 240), 14: (160, 240), 15: (225, 268), 16: (175, 268),
})
BOX = (150, 40, 250, 380)


def best(scores):
    return max(scores, key=scores.get)


class ClassifyPostureTest(unittest.TestCase):
    def test_standing(self):
        scores, visibility = classify_posture(*STANDING)
        self.assertEqual(best(scores), "STANDING")
        self.assertGreater(scores["STANDING"], 0.8)
        self.assertGreater(visibility, 0.8)

    def test_seated_side_view(self):
        scores, _ = classify_posture(*SEATED_SIDE)
        self.assertEqual(best(scores), "SEATED")
        self.assertGreater(scores["SEATED"], 0.8)

    def test_seated_frontal_view_trusts_the_thigh_drop_over_the_straight_looking_leg(self):
        scores, _ = classify_posture(*SEATED_FRONTAL)
        self.assertEqual(best(scores), "SEATED")
        self.assertGreaterEqual(scores["SEATED"] - scores["STANDING"], 0.15)

    def test_crouched(self):
        scores, _ = classify_posture(*CROUCHED)
        self.assertEqual(best(scores), "CROUCHED")

    def test_legs_hidden_is_unknown(self):
        scores, visibility = classify_posture(*LEGS_HIDDEN)
        self.assertEqual(max(scores.values()), 0.0)
        self.assertLess(visibility, 0.6)

    def test_no_torso_is_unknown(self):
        scores, _ = classify_posture(*skeleton({13: (200, 280), 14: (180, 280)}))
        self.assertEqual(max(scores.values()), 0.0)


class OrientationTest(unittest.TestCase):
    def test_facing_camera(self):
        yaw, confidence = estimate_orientation(*STANDING)
        self.assertAlmostEqual(yaw, 0.0, delta=5)
        self.assertGreater(confidence, 0.8)

    def test_facing_away(self):
        yaw, confidence = estimate_orientation(*AWAY)
        self.assertAlmostEqual(abs(yaw), 180.0, delta=5)
        self.assertGreater(confidence, 0.8)

    def test_profile_facing_image_right(self):
        yaw, confidence = estimate_orientation(*SEATED_SIDE)
        self.assertAlmostEqual(yaw, 90.0, delta=15)
        self.assertGreater(confidence, 0.4)

    def test_profile_facing_image_left(self):
        keypoints, confs = SEATED_SIDE
        mirrored = [(400 - x, y) for x, y in keypoints]
        # Mirroring swaps which shoulder is the subject's left.
        mirrored[5], mirrored[6] = mirrored[6], mirrored[5]
        yaw, _ = estimate_orientation(mirrored, confs)
        self.assertAlmostEqual(yaw, -90.0, delta=15)

    def test_turned_toward_image_right_while_facing_camera(self):
        keypoints, confs = skeleton({
            0: (215, 60), 1: (222, 52), 2: (205, 52),
            5: (225, 100), 6: (175, 100), 11: (215, 200), 12: (185, 200),
        })
        yaw, _ = estimate_orientation(keypoints, confs)
        self.assertGreater(yaw, 20)
        self.assertLess(yaw, 70)

    def test_hidden_shoulders_give_no_orientation(self):
        self.assertEqual(estimate_orientation(*skeleton({0: (200, 60), 11: (220, 200)})), (None, 0.0))


class AnchorTest(unittest.TestCase):
    def test_visible_ankles_are_the_floor_contact(self):
        point, mode = anchor_for(*STANDING, BOX, "STANDING")
        self.assertEqual(mode, "POSE_ANKLES")
        self.assertEqual(point, (200.0, 370.0))

    def test_a_crouched_reading_is_placed_by_the_shoulders_not_guessed_ankles(self):
        _, mode = anchor_for(*STANDING, BOX, "CROUCHED")
        self.assertEqual(mode, "POSE_SHOULDER_HEIGHT", "seated from behind, ankles are guesses under the chair")

    def test_hidden_feet_use_the_shoulders_even_with_knees_seen(self):
        knees = skeleton({**FACE_FRONT, **SHOULDERS_FRONT, 11: (220, 200), 12: (180, 200), 13: (222, 250), 14: (178, 250)})
        _, mode = anchor_for(*knees, BOX, "SEATED")
        self.assertEqual(mode, "POSE_SHOULDER_HEIGHT", "one method frame after frame, whatever the knees do")

    def test_legs_hidden_send_the_shoulders_else_the_hips_at_posture_height(self):
        from cctv_twin_pose import hip_anchor_height
        point, mode = anchor_for(*LEGS_HIDDEN, BOX, "UNKNOWN")
        self.assertEqual(mode, "POSE_SHOULDER_HEIGHT")
        self.assertEqual(hip_anchor_height("UNKNOWN", mode), 1.0)
        kp, cf = LEGS_HIDDEN
        no_shoulders = [0.0 if i in (5, 6) else c for i, c in enumerate(cf)]
        point, mode = anchor_for(kp, no_shoulders, BOX, "UNKNOWN")
        self.assertEqual((point, mode), ((200.0, 200.0), "POSE_HIP_HEIGHT"))
        self.assertEqual(hip_anchor_height("UNKNOWN"), 0.5)
        self.assertEqual(hip_anchor_height("STANDING"), 0.95)

    def test_no_pose_falls_back_to_the_box(self):
        self.assertEqual(anchor_for(None, None, BOX, "SEATED"), ((200.0, 380.0), "OCCUPANCY_PROXY"))


class SmootherTest(unittest.TestCase):
    SEAT = {"STANDING": 0.1, "SEATED": 0.9, "CROUCHED": 0.0}
    STAND = {"STANDING": 0.9, "SEATED": 0.1, "CROUCHED": 0.0}

    def test_first_posture_needs_two_consecutive_updates(self):
        smoother = PostureSmoother()
        self.assertEqual(smoother.update("7", self.SEAT, 0.0), ("UNKNOWN", 0.0))
        posture, confidence = smoother.update("7", self.SEAT, 0.6)
        self.assertEqual(posture, "SEATED")
        self.assertGreater(confidence, 0.8)

    def test_a_single_contrary_frame_does_not_flip_the_state(self):
        smoother = PostureSmoother()
        smoother.update("7", self.SEAT, 0.0)
        smoother.update("7", self.SEAT, 0.6)
        self.assertEqual(smoother.update("7", self.STAND, 1.2)[0], "SEATED")
        self.assertEqual(smoother.update("7", self.SEAT, 1.8)[0], "SEATED")

    def test_a_sustained_change_switches_after_margin_and_confirmation(self):
        smoother = PostureSmoother()
        smoother.update("7", self.SEAT, 0.0)
        smoother.update("7", self.SEAT, 0.6)
        states = [smoother.update("7", self.STAND, 1.2 + 0.6 * i)[0] for i in range(5)]
        self.assertEqual(states[:3], ["SEATED", "SEATED", "SEATED"])
        self.assertEqual(states[-1], "STANDING")

    def test_decays_to_unknown_without_pose(self):
        smoother = PostureSmoother()
        smoother.update("7", self.SEAT, 0.0)
        smoother.update("7", self.SEAT, 0.6)
        empty = {"STANDING": 0.0, "SEATED": 0.0, "CROUCHED": 0.0}
        self.assertEqual(smoother.update("7", empty, 4.0)[0], "SEATED")
        self.assertEqual(smoother.current("7", 5.5)[0], "SEATED")
        self.assertEqual(smoother.current("7", 5.7), ("UNKNOWN", 0.0))

    def test_tracks_are_independent(self):
        smoother = PostureSmoother()
        for t in (0.0, 0.6):
            smoother.update("a", self.SEAT, t)
            smoother.update("b", self.STAND, t)
        self.assertEqual(smoother.current("a", 1.0)[0], "SEATED")
        self.assertEqual(smoother.current("b", 1.0)[0], "STANDING")


class OcclusionHoldTest(unittest.TestCase):
    EMPTY = {"STANDING": 0.0, "SEATED": 0.0, "CROUCHED": 0.0}

    def seated(self):
        smoother = PostureSmoother()
        for t in (0.0, 0.6):
            smoother.update("7", classify_posture(*SEATED_FRONTAL)[0], t, *SEATED_FRONTAL)
        self.assertEqual(smoother.current("7", 0.6)[0], "SEATED")
        return smoother

    def test_steady_shoulders_keep_a_seated_person_seated_behind_a_table(self):
        smoother = self.seated()
        for t in range(2, 30, 2):
            smoother.update("7", self.EMPTY, float(t), *LEGS_HIDDEN)
        posture, confidence = smoother.current("7", 30.0)
        self.assertEqual(posture, "SEATED")
        self.assertLess(confidence, 0.9, "held confidence eases down")

    def test_rising_shoulders_release_the_hold(self):
        smoother = self.seated()
        risen = skeleton({**{k: (v[0], v[1] - 90) for k, v in {**FACE_FRONT, **SHOULDERS_FRONT}.items()}, 11: (220, 110), 12: (180, 110)})
        for t in range(2, 12, 2):
            smoother.update("7", self.EMPTY, float(t), *risen)
        self.assertEqual(smoother.current("7", 12.0), ("UNKNOWN", 0.0))

    def test_no_shoulders_no_hold(self):
        smoother = self.seated()
        nothing = skeleton({})
        for t in range(2, 12, 2):
            smoother.update("7", self.EMPTY, float(t), *nothing)
        self.assertEqual(smoother.current("7", 12.0), ("UNKNOWN", 0.0))

    def test_the_hold_is_capped(self):
        smoother = self.seated()
        for t in range(2, 120, 2):
            smoother.update("7", self.EMPTY, float(t), *LEGS_HIDDEN)
        self.assertEqual(smoother.current("7", 120.0), ("UNKNOWN", 0.0))


class AnchorStabilizerTest(unittest.TestCase):
    def test_box_jitter_does_not_move_a_still_person(self):
        stab = AnchorStabilizer()
        stab.update("1", (300, 400), 200, 0.0)
        jitter = [(312, 395), (291, 408), (305, 386), (296, 412), (309, 401)]
        points = [stab.update("1", p, 200, 0.5 * (i + 1)) for i, p in enumerate(jitter)]
        for x, y in points:
            self.assertLess(abs(x - 300) + abs(y - 400), 12, "stays within a few px of where they sit")

    def test_walking_is_followed(self):
        stab = AnchorStabilizer()
        stab.update("1", (100, 400), 200, 0.0)
        x = 100
        for i in range(1, 6):
            x, _ = stab.update("1", (100 + 60 * i, 400), 200, 0.5 * i)
        self.assertGreater(x, 300, "a person walking 60 px per frame is followed")

    def test_a_single_spike_is_ignored(self):
        stab = AnchorStabilizer()
        stab.update("1", (300, 400), 200, 0.0)
        x, _ = stab.update("1", (360, 400), 200, 0.5)
        self.assertLess(x, 310)
        x, _ = stab.update("1", (302, 400), 200, 1.0)
        self.assertLess(abs(x - 300), 6)



from cctv_twin_pose import (  # noqa: E402
    EvidenceSmoother, KeypointSmoother, ObjectConfirmer, classify_gestures, hand_object_scores,
)

# Seated, frontal: shoulders y=100, hips y=200, T = 100.
UPPER = {**FACE_FRONT, **SHOULDERS_FRONT, 11: (220, 200), 12: (180, 200)}
PHONE_CALL = skeleton({**UPPER, 7: (245, 150), 9: (215, 62), 8: (160, 150), 10: (165, 190)})
TYPING = skeleton({**UPPER, 7: (240, 170), 9: (215, 175), 8: (160, 170), 10: (185, 175)})
ARMS_DOWN = skeleton({**UPPER, 7: (232, 160), 9: (234, 220), 8: (168, 160), 10: (166, 220)})


class GestureTest(unittest.TestCase):
    def test_hand_at_head(self):
        scores = classify_gestures(*PHONE_CALL)
        self.assertGreater(scores["HAND_AT_HEAD"], 0.6)
        self.assertLess(scores["HANDS_FORWARD"], 0.1, "one hand at the head is not both hands forward")

    def test_hands_forward(self):
        scores = classify_gestures(*TYPING)
        self.assertGreater(scores["HANDS_FORWARD"], 0.6)
        self.assertLess(scores["HAND_AT_HEAD"], 0.2)

    def test_arms_down_is_no_gesture(self):
        self.assertTrue(all(v < 0.2 for v in classify_gestures(*ARMS_DOWN).values()))

    def test_hidden_arms_are_no_gesture(self):
        self.assertTrue(all(v == 0 for v in classify_gestures(*LEGS_HIDDEN).values()))

    def test_gestures_need_persistence(self):
        smoother = EvidenceSmoother()
        self.assertEqual(smoother.update("1", {"HAND_AT_HEAD": 0.9}, 0.0), [])
        self.assertEqual(smoother.update("1", {"HAND_AT_HEAD": 0.9}, 0.6), [])
        self.assertEqual([g["kind"] for g in smoother.update("1", {"HAND_AT_HEAD": 0.9}, 1.2)], ["HAND_AT_HEAD"])
        self.assertEqual([g["kind"] for g in smoother.update("1", {"HAND_AT_HEAD": 0.0}, 1.8)], ["HAND_AT_HEAD"], "one miss does not drop it")
        for i in range(4):
            out = smoother.update("1", {"HAND_AT_HEAD": 0.0}, 2.4 + 0.6 * i)
        self.assertEqual(out, [])


class KeypointSmootherTest(unittest.TestCase):
    def test_follows_the_box_without_smearing(self):
        smoother = KeypointSmoother()
        kp, cf = TYPING
        smoother.update("1", kp, cf, BOX, 0.0)
        moved = (BOX[0] + 50, BOX[1], BOX[2] + 50, BOX[3])
        out = smoother.current("1", moved, 0.5)
        self.assertAlmostEqual(out[9][0], kp[9][0] + 50, places=6)

    def test_low_confidence_points_fade(self):
        smoother = KeypointSmoother()
        kp, cf = TYPING
        smoother.update("1", kp, cf, BOX, 0.0)
        hidden = [0.05] * 17
        smoother.update("1", kp, hidden, BOX, 0.5)
        self.assertLess(smoother.current("1", BOX, 0.6)[9][2], 0.6)


class ObjectConfirmerTest(unittest.TestCase):
    def test_a_single_confident_detection_is_never_shown(self):
        confirmer = ObjectConfirmer()
        self.assertEqual(confirmer.update([("LAPTOP", 0.9, (10, 10, 60, 40))], 0.0), [])

    def test_repeated_sightings_confirm_with_a_stable_id(self):
        confirmer = ObjectConfirmer()
        out = []
        for i in range(3):
            out = confirmer.update([("LAPTOP", 0.6, (10 + i, 10, 60 + i, 40))], float(i))
        self.assertEqual(len(out), 1)
        self.assertEqual(out[0]["id"], "laptop-1")

    def test_unlisted_and_weak_types_are_ignored(self):
        confirmer = ObjectConfirmer()
        for i in range(5):
            out = confirmer.update([("POTTED_PLANT", 0.9, (0, 0, 10, 10)), ("PHONE", 0.2, (0, 0, 5, 5))], float(i))
        self.assertEqual(out, [])

    def test_flicker_below_the_quorum_is_not_confirmed(self):
        confirmer = ObjectConfirmer()
        pattern = [True, False, False, True, False, False, True, False]
        out = []
        for i, seen in enumerate(pattern):
            out = confirmer.update([("CUP", 0.7, (5, 5, 15, 15))] if seen else [], float(i))
        self.assertEqual(out, [])


class HandObjectTest(unittest.TestCase):
    def test_phone_at_the_wrist(self):
        kp, cf = PHONE_CALL
        phone = {"type": "PHONE", "box": (205, 50, 228, 75), "confidence": 0.6}
        self.assertGreater(hand_object_scores(kp, cf, [phone])["PHONE_IN_HAND"], 0.7)

    def test_phone_gripped_in_the_fingers_beyond_the_wrist_counts(self):
        # Forearm up toward the face; the phone sits in the fingers, its lower
        # edge 22 px (0.6 hand) beyond the wrist point, detected at 0.45.
        kp, cf = PHONE_CALL
        kp = list(kp); kp[7], kp[9] = (245.0, 190.0), (225.0, 140.0)
        phone = {"type": "PHONE", "box": (210, 86, 232, 118), "confidence": 0.45}
        self.assertGreater(hand_object_scores(kp, cf, [phone])["PHONE_IN_HAND"], 0.6)

    def test_phone_lying_beside_a_typing_hand_is_not_in_hand(self):
        kp, cf = TYPING
        phone = {"type": "PHONE", "box": (240, 172, 255, 200), "confidence": 0.8}  # off the side of the wrist
        self.assertEqual(hand_object_scores(kp, cf, [phone])["PHONE_IN_HAND"], 0.0)

    def test_hidden_hips_still_measure_the_hand_by_the_shoulders(self):
        # Seated behind the table: no hips, so no torso; a phone at the wrist
        # was scored 0 for it (live).
        kp, cf = PHONE_CALL
        cf = list(cf); cf[11] = cf[12] = 0.2
        phone = {"type": "PHONE", "box": (205, 50, 228, 75), "confidence": 0.6}
        self.assertGreater(hand_object_scores(kp, cf, [phone])["PHONE_IN_HAND"], 0.7)

    def test_a_body_leaning_toward_the_camera_keeps_its_hand_size(self):
        # Torso foreshortened to 40 px under 56 px shoulders: the hand is
        # still ~29 px, so a phone 12 px from the wrist is in it.
        kp, cf = TYPING
        kp = list(kp); kp[11], kp[12] = (220.0, 140.0), (180.0, 140.0)
        phone = {"type": "PHONE", "box": (180, 150, 210, 163), "confidence": 0.8}
        self.assertGreater(hand_object_scores(kp, cf, [phone])["PHONE_IN_HAND"], 0.6)

    def test_a_phone_far_from_both_hands_is_not_in_hand_however_sure(self):
        kp, cf = PHONE_CALL
        phone = {"type": "PHONE", "box": (300, 60, 320, 90), "confidence": 0.95}
        self.assertEqual(hand_object_scores(kp, cf, [phone])["PHONE_IN_HAND"], 0.0)

    def test_phone_on_the_table_is_not_in_hand(self):
        kp, cf = ARMS_DOWN
        phone = {"type": "PHONE", "box": (300, 230, 320, 245), "confidence": 0.8}
        self.assertEqual(hand_object_scores(kp, cf, [phone])["PHONE_IN_HAND"], 0.0)


from cctv_twin_pose import TrackStitcher  # noqa: E402


class TrackStitcherTest(unittest.TestCase):
    def test_a_new_tracker_id_for_the_same_body_keeps_the_old_id(self):
        s = TrackStitcher()
        self.assertEqual(s.resolve({"7": (100, 100, 160, 260)}, 0.0), {"7": "7"})
        self.assertEqual(s.resolve({}, 0.5), {})  # lost behind the table
        self.assertEqual(s.resolve({"12": (104, 102, 163, 262)}, 1.0), {"12": "7"})
        self.assertEqual(s.resolve({"12": (106, 102, 165, 262)}, 1.5), {"12": "7"}, "and keeps it")

    def test_a_visible_neighbour_is_never_taken_over(self):
        s = TrackStitcher()
        s.resolve({"1": (100, 100, 160, 260), "2": (170, 100, 230, 260)}, 0.0)
        got = s.resolve({"1": (100, 100, 160, 260), "9": (172, 100, 232, 260)}, 0.3)
        self.assertEqual(got["1"], "1")
        self.assertEqual(got["9"], "2", "the lost neighbour's id, not the visible one")

    def test_someone_else_far_away_is_a_new_person(self):
        s = TrackStitcher()
        s.resolve({"1": (100, 100, 160, 260)}, 0.0)
        self.assertEqual(s.resolve({"5": (500, 100, 560, 260)}, 0.5), {"5": "5"})

    def test_a_long_gone_track_is_not_revived(self):
        s = TrackStitcher(hold_s=6.0)
        s.resolve({"1": (100, 100, 160, 260)}, 0.0)
        self.assertEqual(s.resolve({"8": (100, 100, 160, 260)}, 7.0), {"8": "8"})

    def test_a_much_smaller_box_is_not_the_same_body(self):
        s = TrackStitcher()
        s.resolve({"1": (100, 100, 160, 260)}, 0.0)
        self.assertEqual(s.resolve({"3": (120, 220, 140, 262)}, 0.5), {"3": "3"})


from cctv_twin_pose import head_anchor_height  # noqa: E402


class HeadAnchorTest(unittest.TestCase):
    """Someone cut off by the bottom of the frame is placed from their head."""

    def test_a_cut_off_box_sends_its_top_the_crown(self):
        from cctv_twin_pose import hip_anchor_height
        point, mode = anchor_for(*LEGS_HIDDEN, (BOX[0], BOX[1], BOX[2], 360.0), "SEATED", frame_height=360)
        self.assertEqual(mode, "BOX_TOP_HEIGHT")
        self.assertEqual(point, ((BOX[0] + BOX[2]) / 2.0, BOX[1]))
        self.assertEqual(hip_anchor_height("UNKNOWN", mode), 1.3)
        self.assertEqual(hip_anchor_height("STANDING", mode), 1.75)
        self.assertLess(point[1], 360.0 - 3, "a head pixel, well above the edge")
        self.assertAlmostEqual(head_anchor_height(*LEGS_HIDDEN, "SEATED"), 1.2)

    def test_an_uncut_box_keeps_its_old_anchor(self):
        self.assertEqual(anchor_for(*LEGS_HIDDEN, BOX, "UNKNOWN", frame_height=720)[1], "POSE_SHOULDER_HEIGHT")

    def test_without_keypoints_a_cut_off_box_still_sends_its_top(self):
        point, mode = anchor_for(None, None, (100, 100, 300, 360), "SEATED", frame_height=360)
        self.assertEqual((point, mode), ((200.0, 100.0), "BOX_TOP_HEIGHT"))

    def test_a_box_cut_at_both_edges_has_no_crown_and_falls_back(self):
        _, mode = anchor_for(None, None, (100, 0, 300, 360), "SEATED", frame_height=360)
        self.assertEqual(mode, "OCCUPANCY_PROXY")


from cctv_twin_pose import AnchorModeHold, anchor_candidates  # noqa: E402


class SeatedAnchorTest(unittest.TestCase):
    def test_a_seated_person_is_not_placed_by_feet_under_the_table(self):
        kp, cf = SEATED_FRONTAL
        self.assertEqual(anchor_candidates(kp, cf, BOX, "SEATED")[0][1], "POSE_SHOULDER_HEIGHT")
        self.assertIn("POSE_ANKLES", [m for _, m in anchor_candidates(kp, cf, BOX, "SEATED")], "still a fallback")
        self.assertEqual(anchor_candidates(*STANDING, BOX, "STANDING")[0][1], "POSE_ANKLES")

    def test_a_cup_redetected_with_a_shifted_box_keeps_its_id(self):
        from cctv_twin_pose import ObjectConfirmer
        c = ObjectConfirmer(need=1, window=5)
        first = c.update([("CUP", 0.6, (100, 100, 130, 140))], 0.0)[0]["id"]
        moved = c.update([("CUP", 0.6, (112, 104, 142, 146))], 4.0)  # IoU ~0.4 of a small box, shifted
        self.assertEqual([o["id"] for o in moved], [first])
        far = c.update([("CUP", 0.6, (300, 100, 330, 140))], 8.0)
        self.assertEqual(len({o["id"] for o in far}), 2, "a cup elsewhere is another cup")


class ShirtWithoutHipsTest(unittest.TestCase):
    def test_the_shirt_colour_is_read_below_the_shoulders_when_the_hips_are_hidden(self):
        import numpy as np
        from cctv_twin_pose import clothing_colours
        frame = np.zeros((400, 400, 3), dtype=np.uint8)
        frame[100:200, 150:250] = (60, 160, 90)  # BGR green shirt under the shoulders
        colours = clothing_colours(frame, *LEGS_HIDDEN_NO_HIPS)
        self.assertEqual(colours["shirt"], "#5aa03c")
        self.assertIsNone(colours["trousers"])


class ChairMapTest(unittest.TestCase):
    def test_a_chair_hidden_behind_its_sitter_is_remembered_with_one_id(self):
        from cctv_twin_pose import ChairMap
        chairs = ChairMap(need=3, keep_s=120.0)
        box = (100, 100, 160, 200)
        jitter = [(0, 0), (4, -3), (-3, 2), (5, 4)]
        for i, (dx, dy) in enumerate(jitter):
            out = chairs.update([(0.5, (box[0] + dx, box[1] + dy, box[2] + dx, box[3] + dy))], i * 4.0)
        self.assertEqual(len(out), 1)
        cid = out[0]["id"]
        # Live: the sitter hid it for minutes; one id, same place, throughout.
        for t in range(20, 120, 4):
            out = chairs.update([], float(t))
        self.assertEqual([o["id"] for o in out], [cid])
        self.assertLessEqual(max(abs(a - b) for a, b in zip(out[0]["box"], box)), 4)
        self.assertEqual(chairs.update([], 12.0 + 125.0), [], "forgotten after keep_s unseen")

    def test_both_detectors_feed_one_chair(self):
        from cctv_twin_pose import ChairMap
        chairs = ChairMap(need=3)
        for t in range(4):
            chairs.update([(0.6, (100, 100, 160, 200))], t * 4.0)  # COCO
            out = chairs.update([(0.4, (103, 98, 162, 204))], t * 4.0 + 1)  # World
        self.assertEqual(len(out), 1)

    def test_part_of_a_chair_inside_its_box_is_that_chair(self):
        from cctv_twin_pose import ChairMap
        chairs = ChairMap(need=3)
        for t in range(3):
            chairs.update([(0.6, (369, 256, 529, 358))], t * 4.0)
        for t in range(3, 7):
            out = chairs.update([(0.4, (471, 257, 529, 357))], t * 4.0)  # live: its right part only
        self.assertEqual(len(out), 1)

    def test_a_tiny_box_is_never_a_chair(self):
        from cctv_twin_pose import StaticObjectMap
        objects = StaticObjectMap(need=3)
        for t in range(5):
            out = objects.update([("CHAIR", 0.6, (568, 290, 592, 322))], t * 4.0)  # live: 24 x 32 px
        self.assertEqual(out, [])

    def test_a_weak_one_off_is_never_a_chair(self):
        from cctv_twin_pose import ChairMap
        chairs = ChairMap(need=3)
        self.assertEqual(chairs.update([(0.25, (300, 100, 360, 200))], 0.0), [])
        self.assertEqual(chairs.update([(0.5, (300, 100, 360, 200))], 4.0), [])


class SeatedOnChairTest(unittest.TestCase):
    def test_hips_inside_a_chair_box_are_seated_not_crouched(self):
        from cctv_twin_pose import seated_on_chair
        kp = [(0.0, 0.0)] * 17; cf = [0.0] * 17
        kp = list(kp); cf = list(cf)
        kp[5], kp[6], kp[11], kp[12] = (400, 280), (440, 280), (405, 360), (435, 360)
        cf[5] = cf[6] = cf[11] = cf[12] = 0.9
        scores = {"STANDING": 0.0, "SEATED": 0.1, "CROUCHED": 0.8}
        out = seated_on_chair(scores, kp, cf, [(337, 242, 486, 503)])
        self.assertEqual(out["CROUCHED"], 0.0)
        self.assertAlmostEqual(out["SEATED"], 0.9)
        self.assertEqual(seated_on_chair(scores, kp, cf, [(600, 242, 700, 503)]), scores, "no chair under the hips")


class ObjectColourTest(unittest.TestCase):
    def test_a_bag_colour_is_the_middle_of_its_box(self):
        import numpy as np
        from cctv_twin_pose import object_colour
        frame = np.zeros((100, 100, 3), np.uint8)
        frame[20:80, 20:80] = (154, 111, 46)  # BGR of a blue backpack
        self.assertEqual(object_colour(frame, (10, 10, 90, 90)), "#2e6f9a")
        self.assertIsNone(object_colour(None, (10, 10, 90, 90)))


class DeskPartsAndGripTest(unittest.TestCase):
    def test_a_laptops_own_keyboard_is_not_a_second_object(self):
        from cctv_twin_pose import StaticObjectMap
        m = StaticObjectMap(need=1)
        out = m.update([("LAPTOP", 0.8, (803, 201, 930, 344)), ("KEYBOARD", 0.6, (820, 260, 920, 340))], 0.0)
        self.assertEqual([o["type"] for o in out], ["LAPTOP"])
        out = m.update([("LAPTOP", 0.8, (803, 201, 930, 344)), ("LAPTOP", 0.5, (840, 250, 925, 340))], 4.0)
        self.assertEqual(len([o for o in out if o["type"] == "LAPTOP"]), 1, "a part of a laptop is that laptop")
        out = m.update([("LAPTOP", 0.8, (802, 196, 925, 340)), ("MONITOR", 0.44, (756, 165, 885, 259))], 8.0)
        self.assertEqual([o["type"] for o in out], ["LAPTOP"], "its screen, half on its box, is not a monitor")

    def test_a_laptop_seen_as_screen_or_keys_alone_stays_one_laptop(self):
        from cctv_twin_pose import StaticObjectMap
        m = StaticObjectMap(need=1)
        m.update([("LAPTOP", 0.8, (604, 180, 734, 308))], 0.0)
        # Its left edge only, 39% inside (live, with someone leaning over it).
        out = m.update([("LAPTOP", 0.8, (567, 167, 635, 253))], 2.0)
        self.assertEqual(len(out), 1)
        # Its keys alone, the screen hidden by the man typing on it.
        m = StaticObjectMap(need=1)
        m.update([("LAPTOP", 0.8, (803, 195, 930, 250))], 0.0)
        out = m.update([("LAPTOP", 0.8, (802, 252, 927, 340))], 2.0)
        self.assertEqual(len(out), 1)
        # Two laptops side by side stay two.
        out = m.update([("LAPTOP", 0.8, (604, 180, 734, 308)), ("LAPTOP", 0.8, (802, 252, 927, 340))], 4.0)
        self.assertEqual(len(out), 2)

    def test_a_second_box_on_a_laptop_in_the_same_scan_is_not_a_new_one(self):
        from cctv_twin_pose import StaticObjectMap
        m = StaticObjectMap(need=1)
        m.update([("LAPTOP", 0.9, (604, 180, 734, 308))], 0.0)
        out = m.update([("LAPTOP", 0.9, (604, 180, 734, 308)), ("LAPTOP", 0.7, (650, 240, 734, 308))], 2.0)
        self.assertEqual(len(out), 1)

    def test_a_faint_laptop_is_not_published(self):
        from cctv_twin_pose import StaticObjectMap
        m = StaticObjectMap(need=3)
        for t in range(6):  # live: 0.44-0.55 at an empty spot, recording after recording
            out = m.update([("LAPTOP", 0.48, (567, 167, 635, 253))], float(t))
        self.assertEqual(out, [])
        for t in range(6, 9):
            out = m.update([("LAPTOP", 0.85, (567, 167, 635, 253))], float(t))
        self.assertEqual(len(out), 1, "a clear laptop is")

    def test_a_backpack_and_a_handbag_in_one_place_are_one_bag(self):
        from cctv_twin_pose import StaticObjectMap
        m = StaticObjectMap(need=1)
        out = m.update([("BACKPACK", 0.6, (350, 518, 540, 716)), ("HANDBAG", 0.5, (354, 518, 534, 720))], 0.0)
        self.assertEqual(len(out), 1)

    def test_a_phone_held_in_both_hands_counts(self):
        from cctv_twin_pose import hand_object_scores
        kp, cf = STANDING
        kp = list(kp); cf = list(cf)
        kp[9], kp[10] = (215.0, 160.0), (185.0, 165.0)  # wrists together at the chest
        cf[9] = cf[10] = 0.9
        phone = {"type": "PHONE", "box": (194, 152, 206, 170), "confidence": 0.8}
        self.assertGreater(hand_object_scores(kp, cf, [phone])["PHONE_IN_HAND"], 0.6)


class ObjectHoldTest(unittest.TestCase):
    def test_a_confirmed_object_does_not_blink_out_between_sightings(self):
        from cctv_twin_pose import ObjectConfirmer
        c = ObjectConfirmer(need=3, window=5, keep_s=12.0)
        box = (100, 100, 140, 180)
        seen = [True, True, True, False, False, True, False, False, False, True]
        counts = [len(c.update([("BOTTLE", 0.5, box)] if s else [], i * 4.0)) for i, s in enumerate(seen)]
        self.assertEqual(counts[2:], [1] * 8, counts)
        for i in range(10, 14):
            out = c.update([], i * 4.0)
        self.assertEqual(out, [], "gone once unseen for longer than keep_s")


class StandingEvidenceTest(unittest.TestCase):
    def test_a_standing_person_with_hidden_feet_is_placed_by_the_hips(self):
        kp, cf = LEGS_HIDDEN
        self.assertEqual(anchor_candidates(kp, cf, BOX, "STANDING")[0][1], "POSE_HIP_HEIGHT")
        self.assertEqual(anchor_candidates(kp, cf, BOX, "SEATED")[0][1], "POSE_SHOULDER_HEIGHT")
        self.assertEqual(anchor_candidates(kp, cf, BOX, "UNKNOWN")[0][1], "POSE_SHOULDER_HEIGHT")

    def test_the_lean_is_reported_before_the_posture_is_confirmed(self):
        smoother = PostureSmoother(dwell_s=3.0)
        # Live: bent over the table, knees seen.
        smoother.update("p", {"STANDING": 0.65, "SEATED": 0.35, "CROUCHED": 0.0}, 0.0)
        self.assertEqual(smoother.current("p", 0.0)[0], "UNKNOWN")
        self.assertEqual(smoother.lean("p", 0.0)[0], "STANDING")
        smoother.update("q", {"STANDING": 0.5, "SEATED": 0.45, "CROUCHED": 0.0}, 0.0)
        self.assertEqual(smoother.lean("q", 0.0)[0], "UNKNOWN", "too close to call")
        self.assertEqual(smoother.lean("nobody", 0.0), ("UNKNOWN", 0.0))

    def test_a_guessed_knee_is_no_evidence_of_sitting(self):
        kp, cf = SEATED_FRONTAL
        guessed = [0.45 if i in (13, 14) else c for i, c in enumerate(cf)]
        self.assertEqual(classify_posture(kp, guessed)[0]["SEATED"], 0.0)
        weak = [0.55 if i in (13, 14) else c for i, c in enumerate(cf)]
        self.assertLess(classify_posture(kp, weak)[0]["SEATED"], classify_posture(kp, cf)[0]["SEATED"])

    def test_walking_in_then_standing_at_the_table_stays_standing(self):
        # Live, 15 Oct: whole legs seen for ~1 s as he walked in, then hidden
        # by the table edge, with knees guessed (0.5) behind it.
        smoother = PostureSmoother(dwell_s=3.0)
        t = 0.0
        for _ in range(4):
            smoother.update("w", classify_posture(*STANDING)[0], t, *STANDING); t += 0.4
        self.assertEqual(smoother.current("w", t)[0], "STANDING", "strong evidence confirms before the full dwell")
        kp, cf = SEATED_FRONTAL
        guessed = [0.5 if i in (13, 14) else (0.0 if i in (15, 16) else c) for i, c in enumerate(cf)]
        for _ in range(8):  # he stood there ~8 s; past 10 s it would lapse (see below)
            smoother.update("w", classify_posture(*LEGS_HIDDEN)[0], t, *LEGS_HIDDEN); t += 0.5
            smoother.update("w", classify_posture(kp, guessed)[0], t, kp, guessed); t += 0.5
        posture, confidence = smoother.current("w", t)
        self.assertEqual(posture, "STANDING")
        self.assertGreaterEqual(confidence, 0.5, "still above the backend's gate")

    def test_standing_with_the_legs_hidden_lapses_after_ten_seconds(self):
        # Live: walked in (legs seen), sat down behind the table; from above
        # the shoulders barely dropped and the knees were never clear.
        smoother = PostureSmoother(dwell_s=3.0)
        t = 0.0
        for _ in range(4):
            smoother.update("w", classify_posture(*STANDING)[0], t, *STANDING); t += 0.4
        for _ in range(8):
            smoother.update("w", classify_posture(*LEGS_HIDDEN)[0], t, *LEGS_HIDDEN); t += 1.0
        self.assertEqual(smoother.current("w", t)[0], "STANDING", "held while plausibly still standing")
        for _ in range(6):
            smoother.update("w", classify_posture(*LEGS_HIDDEN)[0], t, *LEGS_HIDDEN); t += 1.0
        self.assertEqual(smoother.current("w", t)[0], "UNKNOWN")
        self.assertEqual(smoother.lean("w", t)[0], "UNKNOWN", "no standing hint left to block 'probably seated'")

    def test_a_seated_person_is_not_stood_up_by_weak_evidence(self):
        smoother = PostureSmoother(dwell_s=3.0)
        t = 0.0
        for _ in range(12):
            smoother.update("s", classify_posture(*SEATED_SIDE)[0], t, *SEATED_SIDE); t += 0.4
        self.assertEqual(smoother.current("s", t)[0], "SEATED")
        weak = {"STANDING": 0.55, "SEATED": 0.2, "CROUCHED": 0.0}  # live: guessed knees, shoulders unmoved
        for _ in range(30):
            smoother.update("s", weak, t, *SEATED_SIDE); t += 0.4
        self.assertEqual(smoother.current("s", t)[0], "SEATED")
        # Standing up for real: legs seen clearly.
        for _ in range(12):
            smoother.update("s", classify_posture(*STANDING)[0], t, *STANDING); t += 0.4
        self.assertEqual(smoother.current("s", t)[0], "STANDING")

    def test_a_seated_person_never_flips_to_crouched(self):
        smoother = PostureSmoother(dwell_s=3.0)
        t = 0.0
        for _ in range(12):
            smoother.update("s", classify_posture(*SEATED_SIDE)[0], t, *SEATED_SIDE); t += 0.4
        self.assertEqual(smoother.current("s", t)[0], "SEATED")
        for _ in range(20):
            smoother.update("s", classify_posture(*CROUCHED)[0], t, *CROUCHED); t += 0.4
        self.assertEqual(smoother.current("s", t)[0], "SEATED")

    def test_a_real_sit_down_still_switches_to_seated(self):
        smoother = PostureSmoother(dwell_s=3.0)
        t = 0.0
        for _ in range(4):
            smoother.update("s", classify_posture(*STANDING)[0], t, *STANDING); t += 0.4
        kp, cf = SEATED_FRONTAL
        lowered = [(x, y + 45) for x, y in kp]  # sitting drops the shoulders ~0.45 torso
        for _ in range(20):  # a frontal sit-down scores only ~0.65 SEATED: the full dwell
            smoother.update("s", classify_posture(lowered, cf)[0], t, lowered, cf); t += 0.4
        self.assertEqual(smoother.current("s", t)[0], "SEATED")

    def test_a_hand_at_the_frame_edge_is_not_admitted_as_a_person(self):
        gate = TrackAdmission(admit_s=2.0)
        admitted = set()
        for i in range(12):
            admitted |= gate.update({"hand": 0.44, "person": 0.68}, i * 0.25)
        self.assertEqual(admitted, {"person"})


class AnchorModeHoldTest(unittest.TestCase):
    SH = ((300.0, 500.0), "POSE_SHOULDER_HEIGHT")
    TOP = ((300.0, 400.0), "BOX_TOP_HEIGHT")
    ANK = ((300.0, 700.0), "POSE_ANKLES")
    PROXY = ((300.0, 715.0), "OCCUPANCY_PROXY")

    def test_a_flickering_best_method_does_not_flip_the_anchor(self):
        hold = AnchorModeHold(hold_s=1.0)
        self.assertEqual(hold.choose("a", [self.SH, self.PROXY], 0.0)[1], "POSE_SHOULDER_HEIGHT")
        # Live: the box bottom touched the frame edge every other frame.
        for i, best in enumerate([self.TOP, self.SH, self.TOP, self.ANK, self.TOP, self.SH]):
            others = [c for c in (self.SH, self.TOP) if c is not best]
            point, mode = hold.choose("a", [best, *others, self.PROXY], 0.25 * (i + 1))
            self.assertEqual(mode, "POSE_SHOULDER_HEIGHT")
            self.assertEqual(point, self.SH[0])

    def test_a_lasting_change_is_taken_after_the_hold(self):
        hold = AnchorModeHold(hold_s=1.0)
        hold.choose("a", [self.SH, self.PROXY], 0.0)
        modes = [hold.choose("a", [self.TOP, self.SH, self.PROXY], 0.25 * i)[1] for i in range(1, 7)]
        self.assertEqual(modes[:3], ["POSE_SHOULDER_HEIGHT"] * 3)
        self.assertEqual(modes[-1], "BOX_TOP_HEIGHT")

    def test_an_unusable_method_is_left_at_once(self):
        hold = AnchorModeHold(hold_s=1.0)
        hold.choose("a", [self.SH, self.PROXY], 0.0)
        self.assertEqual(hold.choose("a", [self.TOP, self.PROXY], 0.1)[1], "BOX_TOP_HEIGHT")

    def test_the_crown_stays_usable_while_the_box_only_nearly_reaches_the_edge(self):
        kp, cf = LEGS_HIDDEN
        near = anchor_candidates(kp, cf, (BOX[0], BOX[1], BOX[2], 340.0), "SEATED", frame_height=360)
        self.assertNotEqual(near[0][1], "BOX_TOP_HEIGHT")
        self.assertIn("BOX_TOP_HEIGHT", [mode for _, mode in near])
        far = anchor_candidates(kp, cf, (BOX[0], BOX[1], BOX[2], 250.0), "SEATED", frame_height=360)
        self.assertNotIn("BOX_TOP_HEIGHT", [mode for _, mode in far])


from cctv_twin_pose import TrackAdmission  # noqa: E402


class LongerWindowTest(unittest.TestCase):
    def test_a_brief_or_weak_detection_is_never_published(self):
        gate = TrackAdmission(admit_s=2.0, min_fraction=0.6, min_confidence=0.4)
        admitted = set()
        for i in range(12):  # 3 s at 4 fps
            t = i * 0.25
            seen = {"person": 0.8}
            if i % 3 == 0:
                seen["flicker"] = 0.9   # seen in a third of the frames
            seen["weak"] = 0.25         # always there, but weak
            admitted |= gate.update(seen, t)
        self.assertIn("person", admitted)
        self.assertNotIn("flicker", admitted)
        self.assertNotIn("weak", admitted)

    def test_admission_waits_for_the_window(self):
        gate = TrackAdmission(admit_s=2.0)
        self.assertEqual(gate.update({"p": 0.9}, 0.0), set())
        self.assertEqual(gate.update({"p": 0.9}, 1.0), set())
        self.assertEqual(gate.update({"p": 0.9}, 2.0), {"p"})
        self.assertEqual(gate.update({}, 3.0), set())
        self.assertEqual(gate.update({"p": 0.3}, 4.0), {"p"}, "stays admitted once admitted")

    def test_posture_changes_only_after_it_has_held(self):
        smoother = PostureSmoother(dwell_s=3.0)
        seated = {"STANDING": 0.0, "SEATED": 0.9, "CROUCHED": 0.0}
        standing = {"STANDING": 0.9, "SEATED": 0.0, "CROUCHED": 0.0}
        t = 0.0
        for _ in range(16):
            smoother.update("a", seated, t); t += 0.3
        self.assertEqual(smoother.current("a", t)[0], "SEATED")
        for _ in range(4):  # 1.2 s of standing evidence
            smoother.update("a", standing, t); t += 0.3
        self.assertEqual(smoother.current("a", t)[0], "SEATED", "a moment of odd frames does not flip it")
        for _ in range(10):
            smoother.update("a", standing, t); t += 0.3
        self.assertEqual(smoother.current("a", t)[0], "STANDING")


from cctv_twin_pose import AppearanceSmoother, clothing_colours  # noqa: E402


class AppearanceTest(unittest.TestCase):
    def test_shirt_and_trouser_colours_come_from_the_torso_and_thighs(self):
        import numpy as np
        frame = np.full((400, 300, 3), (200, 200, 200), dtype=np.uint8)
        frame[100:200, 100:200] = (40, 40, 220)    # BGR: a red shirt
        frame[200:300, 110:190] = (90, 50, 30)     # navy trousers
        kp = [(0, 0)] * 17; cf = [0.0] * 17
        for i, xy in {5: (195, 100), 6: (105, 100), 11: (185, 200), 12: (115, 200), 13: (180, 295), 14: (120, 295)}.items():
            kp[i] = xy; cf[i] = 0.9
        colours = clothing_colours(frame, kp, cf)
        self.assertEqual(colours["shirt"], "#dc2828")
        self.assertEqual(colours["trousers"], "#1e325a")

    def test_no_colour_without_a_clear_torso(self):
        import numpy as np
        frame = np.zeros((100, 100, 3), dtype=np.uint8)
        self.assertIsNone(clothing_colours(frame, [(0, 0)] * 17, [0.0] * 17))

    def test_a_brief_occlusion_does_not_recolour_anyone(self):
        s = AppearanceSmoother(keep=5)
        for t in range(4):
            s.update("p", {"shirt": "#dc2828", "trousers": None}, float(t))
        s.update("p", {"shirt": "#202020", "trousers": None}, 4.0)  # a laptop lid in front
        self.assertEqual(s.current("p", 4.0)["shirt"], "#dc2828")


if __name__ == "__main__":
    unittest.main(verbosity=2)
