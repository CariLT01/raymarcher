import * as THREE from "three";
import { OutlinePass } from "three/examples/jsm/postprocessing/OutlinePass.js";
import { EffectComposer } from "three/examples/jsm/postprocessing/EffectComposer.js";
import { RenderPass } from "three/examples/jsm/postprocessing/RenderPass.js";
import Stats from "stats.js";
import { CameraController } from "./cameraController";
import { Solid } from "./csg/objects/solid";
import { TransformControls } from "three/examples/jsm/controls/TransformControls";
import { FBXLoader } from "three/examples/jsm/loaders/FBXLoader";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader";
import { OBJLoader } from "three/examples/jsm/loaders/OBJLoader";
import { STLLoader } from "three/examples/jsm/loaders/STLLoader";
import { SSAOPass } from 'three/examples/jsm/postprocessing/SSAOPass.js';
import { GTAOPass }     from 'three/examples/jsm/postprocessing/GTAOPass';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';

import { encode, decode } from "@msgpack/msgpack";
import { inflateSync, deflateSync } from "fflate";

import { STLExporter } from "three/examples/jsm/exporters/STLExporter.js";

function degToRad(deg: number) {
    return (deg * Math.PI) / 180;
}

interface ExportedData {
    mesh: any; // Replace `any` with the actual type returned by toJSON()
    history: ExportedData[];
    properties: { [key: string]: { values: any[], type: string } };
}
type EditorState = { [key: string]: Solid };

interface FlatNode {
    id: string;
    parentId: string | null;
    name: string;
    type: string;
}

interface TreeNode extends FlatNode {
    children: TreeNode[];
}

/**
 * Renders a nested <ul><li> tree from a flat map of nodes.
 */

function getAllMeshes(object: THREE.Object3D): THREE.Mesh[] {
    const meshes: THREE.Mesh[] = [];
    object.children.forEach((child) => {
        console.log(child);
        meshes.push(child as THREE.Mesh);
    });
    console.log(meshes.length);
    return meshes;
}
function rgbToHex(r: number, g: number, b: number) {
    return "#" + [r, g, b].map(v => v.toString(16).padStart(2, '0')).join('');
}
function hexToRgb(hex: string): [number, number, number] {
    hex = hex.replace(/^#/, "");
    if (hex.length === 3) {
        hex = hex.split("").map(c => c + c).join("");
    }
    const bigint = parseInt(hex, 16);
    const r = (bigint >> 16) & 255;
    const g = (bigint >> 8) & 255;
    const b = bigint & 255;
    return [r, g, b];
}

export class Editor3d {
    camera!: THREE.PerspectiveCamera;
    scene!: THREE.Scene;
    renderer!: THREE.WebGLRenderer;
    raycaster: THREE.Raycaster = new THREE.Raycaster();
    mouse: THREE.Vector2 = new THREE.Vector2();
    outlinePass!: OutlinePass;
    composer!: EffectComposer;

    // Controls
    controls!: CameraController;
    arrowHelper!: TransformControls;
    isMoving: boolean = false;
    arrowHelperSelectedMesh: THREE.Mesh | null = null;
    isLocalSpace: boolean = true;
    scaleStart: THREE.Vector3 = new THREE.Vector3();
    positionStart: THREE.Vector3 = new THREE.Vector3();
    arrowHelperGroup: THREE.Group | null = null;
    // Other
    stats!: Stats;
    currentSolidFound: Solid | null = null;
    currentSolidsSelected: Solid[] = [];
    shiftHeldDown: boolean = false;
    altHeldDown: boolean = false;
    solids: { [key: string]: Solid } = {};
    previousSize: THREE.Vector3 = new THREE.Vector3();
    useFastCSG: boolean = true;
    // Undo
    undoStack: EditorState[] = [];
    redoStack: EditorState[] = [];
    undoStackTree: {
        [key: string]: {
            id: string;
            name: string;
            parentId: string | null;
            type: string;
        };
    }[] = [];
    redoStackTree: {
        [key: string]: {
            id: string;
            name: string;
            parentId: string | null;
            type: string;
        };
    }[] = [];

    previousRaycastedMesh: THREE.Mesh | null = null;

    solidsTree: {
        [key: string]: {
            id: string;
            name: string;
            parentId: string | null;
            type: string;
        };
    } = {};

    clock: THREE.Clock = new THREE.Clock()

    constructor() {
        console.log("Creating new instance of Editor3D");
    }
    initialize() {
        this.initializeBasics();
        this.initializeLighting();
        this.initializeControls();
        this.initializeWindowEvents();
        this.initializeStatistics();
        this.initializeHelpers();

        this.bottomToolbarButtonsInitialize();

        this.initializeMouseEvents();
        this.initializeKeyboardEvents();
        this.initializeControlsEvents();
        this.initializeDebugObjects();
        this.initializeButtonEvents();
        this.initializeImport3DbuttonEvent();
        this.initializeImportSceneEvent();
        this.updateOutlinePass();
    }



    private updatePropertiesTab() {
        const propertiesTab: HTMLDivElement | null = document.querySelector("#properties");
        if (!propertiesTab) {
            throw new Error("Properties tab not found");
        }

        if (this.currentSolidsSelected.length !== 1) {
            propertiesTab.innerHTML = '';
            if (!propertiesTab.parentElement) return;
            //propertiesTab.parentElement.style.display = "none";
            return;
        } else {
            if (!propertiesTab.parentElement) return;
            //propertiesTab.parentElement.style.display = "block";
        }

        propertiesTab.innerHTML = '';

        const solid = this.currentSolidsSelected[0];
        solid.updateProperties();

        const properties = solid.properties;

        for (const propertyName in properties) {
            const propertyValue = properties[propertyName];

            // New entry

            const propertyItemDiv = document.createElement("div");
            propertyItemDiv.classList.add("property-item");
            const propertyLabelElement = document.createElement("label");

            propertyLabelElement.innerText = propertyName;
            propertyItemDiv.appendChild(propertyLabelElement);
            if (propertyValue.type == "Vector3") {
                const inputElement = document.createElement("input");
                inputElement.value = `${propertyValue.values[0]}, ${propertyValue.values[1]}, ${propertyValue.values[2]}`;


                propertyItemDiv.appendChild(inputElement);

                console.log("Added new input for: ", propertyName);
                inputElement.addEventListener("input", () => {
                    console.log("Input element value changed");
                    const str = inputElement.value;
                    const numbers = str.split(',').map(Number);

                    if (numbers.length !== 3) {
                        console.error("Number of numbers not equals to 3: ", numbers.length);
                        return;
                    }
                    solid.updatePropertyItem(propertyName, numbers);

                })


            } else if (propertyValue.type == "Color") {
                const inputElement = document.createElement("input");
                inputElement.type = "color";
                inputElement.value = rgbToHex(propertyValue.values[0], propertyValue.values[1], propertyValue.values[2]);

                propertyItemDiv.appendChild(inputElement);

                inputElement.addEventListener("input", () => {
                    const rgb = hexToRgb(inputElement.value);
                    solid.updatePropertyItem(propertyName, rgb);
                })
            } else if (propertyValue.type == "Number") {
                const inputElement = document.createElement("input");
                inputElement.type = "number";
                inputElement.value = propertyValue.values[0];

                propertyItemDiv.appendChild(inputElement);

                inputElement.addEventListener("input", () => {
                    const value = inputElement.valueAsNumber;
                    console.log("Send:", propertyName, "=", [value]);
                    solid.updatePropertyItem(propertyName, [value]);
                });
            }

            else {
                console.warn("Unrecognized property type: ", propertyValue.type);
            }

            propertiesTab.appendChild(propertyItemDiv);
        }
    }

    private renderTree(
        solidsTree: Record<string, FlatNode>,
        highlighted: { [key: string]: boolean }
    ): HTMLElement {
        // 1) Clone into TreeNodes with empty children
        const map = new Map<string, TreeNode>();
        for (const key in solidsTree) {
            const { id, parentId, name, type } = solidsTree[key];
            map.set(id, { id, parentId, name, type, children: [] });
        }

        // 2) Link children
        const roots: TreeNode[] = [];
        for (const node of map.values()) {
            if (node.parentId === null) {
                roots.push(node);
            } else {
                map.get(node.parentId)?.children.push(node);
            }
        }

        // 3) Recursively build UL/LI structure
        let buildList = (nodes: TreeNode[]) => {
            const ul = document.createElement("ul");
            for (const node of nodes) {
                const li = document.createElement("li");
                const btn = document.createElement("button");
                if (highlighted[node.id]) btn.classList.add("tree-highlighted");
                btn.classList.add("tree-item");

                // See if solid is hidden
                const solid = this.solids[node.id];
                if (solid) {
                    if (this.scene.getObjectById(solid.getMesh().id) == null) {
                        btn.classList.add("tree-item-hidden")
                    }
                }

                btn.textContent = node.name;
                btn.dataset.nodeId = node.id;
                li.appendChild(btn);
                if (node.children.length) {
                    li.appendChild(buildList(node.children));
                }
                btn.addEventListener("click", () => {
                    const solid = this.solids[node.id];
                    if (solid == null) {
                        if (node.type != "group") {
                            console.error("No solid, but not a group");
                            return;
                        }

                        // Check children
                        let numChildren = 0;
                        for (const memberId in this.solidsTree) {
                            const member = this.solidsTree[memberId];
                            if (member.parentId == node.id) {
                                console.log("Found: ", member.id);
                                numChildren++;
                                break;
                            }
                        }

                        if (numChildren == 0) {
                            delete this.solidsTree[node.id];
                            this.updateTree();
                            console.log("Deleted empty group");
                        } else {
                            console.log("Found children");

                            const selectAllDescendants = (toCheckNode: FlatNode) => {
                                for (const memberId in this.solidsTree) {
                                    const member = this.solidsTree[memberId];
                                    if (member.parentId == toCheckNode.id) {
                                        console.log("Found: ", member.id);

                                        const s = this.solids[member.id];
                                        if (s == null) {
                                            if (member.type == "group") {
                                                selectAllDescendants(member);
                                                continue;
                                            } else {
                                                continue;
                                            }
                                        }
                                        if (this.currentSolidsSelected.indexOf(s) === -1) {
                                            this.currentSolidsSelected.push(s);
                                        } else {
                                            this.currentSolidsSelected.splice(
                                                this.currentSolidsSelected.indexOf(s),
                                                1
                                            );
                                        }
                                        this.isMoving = true;
                                        this.updateTree();
                                        this.updateOutlinePass();
                                        this.determineArrowHelperState();
                                        if (this.currentSolidsSelected.length == 0) {
                                            this.isMoving = false;
                                        }
                                    }
                                }
                            };

                            selectAllDescendants(node);
                        }

                        return;
                    }
                    if (this.currentSolidsSelected.indexOf(solid) === -1) {
                        this.currentSolidsSelected.push(solid);
                        this.updateTree();
                        this.updateOutlinePass();
                        this.determineArrowHelperState();
                        this.isMoving = true;
                    } else {
                        this.currentSolidsSelected.splice(
                            this.currentSolidsSelected.indexOf(solid),
                            1
                        );
                        this.updateTree();
                        this.updateOutlinePass();
                        this.determineArrowHelperState();
                        if (this.currentSolidsSelected.length == 0) {
                            this.isMoving = false;
                        }
                    }
                });

                ul.appendChild(li);
            }
            return ul;
        };

        // wrap roots in a container (you can return the UL directly if you prefer)
        const container = document.createElement("div");
        container.appendChild(buildList(roots));
        return container;
    }

    private buildHighlgihtedList() {
        const a: { [key: string]: boolean } = {};
        for (const solid of this.currentSolidsSelected) {
            a[solid.getMesh().uuid] = true;
        }
        return a;
    }

    private updateTree() {
        const tree = document.querySelector("#tree");
        if (!tree) {
            console.error("#tree not found;");
            return;
        }
        tree.innerHTML = "";
        const html = this.renderTree(this.solidsTree, this.buildHighlgihtedList());
        tree.appendChild(html);
    }
    private deleteSolid(solid: Solid) {
        const index = this.solids[solid.getMesh().uuid];
        if (index === null) {
            throw new Error("Solid does not exist");
        }

        const tree = this.solidsTree[solid.getMesh().uuid];
        if (tree == null) {
            throw new Error("Solid not found in tree");
        }
        const solidID = solid.getMesh().uuid;

        // Recursive delete

        delete this.solidsTree[solid.getMesh().uuid];
        for (const id in this.solidsTree) {
            const value = this.solidsTree[id];
            if (value.parentId == solidID) {
                const childSolid: Solid = this.solids[id];
                if (childSolid !== null) {
                    this.deleteSolid(childSolid);
                }
            }
        }
        delete this.solids[solid.getMesh().uuid];
        this.scene.remove(solid.getGroup());

        this.updateTree();
    }
    private getParentOfSolid(object: Solid): Solid | null {
        const p = this.solidsTree[object.getMesh().uuid].parentId;
        if (p == null) return p;
        return this.solids[p];
    }
    private addSolid(object: Solid, parent: Solid | null) {
        this.solids[object.getMesh().uuid] = object;
        if (!parent) {
            this.solidsTree[object.getMesh().uuid] = {
                parentId: null,
                id: object.getMesh().uuid,
                name: object.name,
                type: "solid",
            };
        } else {
            this.solidsTree[object.getMesh().uuid] = {
                parentId: parent.getMesh().uuid,
                id: object.getMesh().uuid,
                name: object.name,
                type: "solid",
            };
        }
        this.scene.add(object.getGroup());

        this.updateTree();
    }

    private addToUndoStack() {
        const cloned: { [key: string]: Solid } = {};
        for (const solidID in this.solids) {
            const solid = this.solids[solidID];
            cloned[solid.getMesh().uuid] = solid.fullClone();
        }
        console.log("Added to undo stack ", cloned);
        this.undoStack.push(cloned);
        console.log(this.undoStack);
    }

    private undoAction() {
        console.log("Undo!");
        if (this.undoStack.length === 0) {
            console.warn("Nothing to undo!");
            return;
        }

        // Save current state for redo BEFORE removing
        const cloned: { [key: string]: Solid } = {};
        for (const solidID in this.solids) {
            const solid = this.solids[solidID];
            cloned[solid.getMesh().uuid] = solid.fullClone();
        }
        this.redoStack.push(cloned);

        // Remove current meshes
        for (const soliID in this.solids) {
            const solid = this.solids[soliID];
            this.scene.remove(solid.getMesh());
        }

        this.currentSolidsSelected = [];
        this.updateOutlinePass();

        // Restore from undo
        this.solids = this.undoStack.pop()!;
        console.log("Solids: ", this.solids);
        console.log("Length: ", this.solids.length);
        for (const solidID in this.solids) {
            const solid = this.solids[solidID];
            console.log("Undid: ", solid);
            this.scene.add(solid.getMesh());
        }
    }

    private arrowHelperAttach(solid: Solid) {
        this.arrowHelper.attach(solid.getGroup());
        this.arrowHelperSelectedMesh = solid.getMesh();
        this.bottomToolbarButtonSetVisibility("localspace", true);
    }
    private arrowHelperDetach() {
        this.arrowHelper.detach();
        this.arrowHelperSelectedMesh = null;

        if (this.arrowHelperGroup) {
            const groupMatrixWorld = this.arrowHelperGroup.matrixWorld;

            for (const selected of this.currentSolidsSelected) {
                const mesh = selected.getMesh();

                if (this.arrowHelperGroup.children.includes(mesh)) {
                    // Update world matrix for the group and child
                    this.arrowHelperGroup.updateMatrixWorld();
                    mesh.updateMatrixWorld();

                    // Save world position/rotation/scale
                    mesh.applyMatrix4(groupMatrixWorld);
                    this.arrowHelperGroup.remove(mesh);
                    this.scene.add(mesh);

                    selected.updateProperties();
                }
            }

            if (this.scene.getObjectById(this.arrowHelperGroup.id)) {
                this.scene.remove(this.arrowHelperGroup);
            }

            this.arrowHelperGroup = null;
        }

        this.bottomToolbarButtonSetVisibility("localspace", false);
    }

    private initializeBasics() {
        // Renderer
        this.renderer = new THREE.WebGLRenderer({ antialias: true });
        this.renderer.setSize(window.innerWidth, window.innerHeight);
        document.body.appendChild(this.renderer.domElement);

        // Scene
        this.scene = new THREE.Scene();

        // Camera (with correct parameters)
        this.camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 100);
        this.camera.position.set(0, 1, 5);

        // Composer
        this.composer = new EffectComposer(this.renderer);

        // RenderPass
        const renderPass = new RenderPass(this.scene, this.camera);
        this.composer.addPass(renderPass);

        // Ambient occlusion
        const gtao = new GTAOPass(this.scene, this.camera, innerWidth, innerHeight);

        // you can debug the raw AO or denoised result:
        gtao.updateGtaoMaterial(
            {
                radius: 0.25,
                screenSpaceRadius: true,
                distanceExponent: 1,
                thickness: 1,
                distanceFallOff: 1,
                scale: 1,
                samples: 16
            }
        )
        gtao.blendIntensity = 1;
        gtao.output = GTAOPass.OUTPUT.Default;  // beauty + AO
        
        // gtao.output = GTAOPass.OUTPUT.AO;    // AO only
        // gtao.output = GTAOPass.OUTPUT.Denoise; // AO + denoiser
        this.composer.addPass( gtao );

        // Outline Pass
        this.outlinePass = new OutlinePass(
            new THREE.Vector2(window.innerWidth, window.innerHeight),
            this.scene,
            this.camera
        );
        this.outlinePass.edgeStrength = 2.85;
        this.outlinePass.edgeGlow = 0;
        this.outlinePass.edgeThickness = 1;
        this.outlinePass.pulsePeriod = 3;
        this.outlinePass.visibleEdgeColor.set("#00aaff");
        this.outlinePass.hiddenEdgeColor.set("#00aaff");
        this.composer.addPass(this.outlinePass);

        const outputPass = new OutputPass();

        this.composer.addPass(outputPass);


        // Light (needed for SSAO)
        const ambient = new THREE.AmbientLight(0xaaaaaa, 0.5);
        const directional = new THREE.DirectionalLight(0xffffff, 0.5);
        directional.position.set(5, 10, 7.5);
        this.scene.add(ambient, directional);

        // Optional pattern texture
        /*
        const loader = new THREE.TextureLoader();
        loader.load('https://threejs.org/examples/textures/tri_pattern.jpg', (texture) => {
            this.outlinePass.usePatternTexture = true;
            this.outlinePass.patternTexture = texture;
            texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
        });
        */

        // Optional controls for debugging
        // new OrbitControls(this.camera, this.renderer.domElement);

        // Resize handler
        window.addEventListener("resize", () => {
            const w = window.innerWidth;
            const h = window.innerHeight;
            this.camera.aspect = w / h;
            this.camera.updateProjectionMatrix();
            this.renderer.setSize(w, h);
            this.composer.setSize(w, h);
        });
    }
    private initializeLighting() {
        // Ambient light for general soft lighting
        const ambient = new THREE.AmbientLight(0xffffff, 0.2);
        this.scene.add(ambient);

        // Directional light for shadows and highlights
        //const directional = new THREE.DirectionalLight(0xffffff, 1);
        //directional.position.set(5, 10, 7);
        //directional.castShadow = true;
        //this.scene.add(directional);

        // Optional: Hemisphere light for subtle sky/ground effect
        //const hemi = new THREE.HemisphereLight(0xaaaaaa, 0x444444, 0.3);
        //hemi.position.set(0, 20, 0);
        //this.scene.add(hemi);
    }

    private initializeControls() {
        this.controls = new CameraController(this.camera);
    }
    private initializeWindowEvents() {
        window.addEventListener("resize", () => {
            this.renderer.setSize(innerWidth, innerHeight);
            this.camera.aspect = innerWidth / innerHeight;
            this.camera.updateProjectionMatrix();
        });
    }

    // Function to adjust the mesh's position based on the selected axis
    private transformControlsAdjustPivot(axis: string | null) {
        /*if (axis == null) {
                console.error("No axis");
                return;
            }
            // Reset position to avoid cumulative offsets
            if (!this.arrowHelperSelectedMesh) return;
            this.arrowHelperSelectedMesh.geometry.computeBoundingBox();
            if (this.arrowHelperSelectedMesh.geometry.boundingBox == null) return;
            const localBox = this.arrowHelperSelectedMesh.geometry.boundingBox.clone();
            const mesh = this.arrowHelperSelectedMesh;
            if (!mesh) return;
            mesh.position.set(0, 0, 0);
    
            switch (axis) {
                case 'X':
                    mesh.position.x = -localBox.max.x; // Scale from the right side
                    break;
                case 'Y':
                    mesh.position.y = -localBox.max.y; // Scale from the top side
                    break;
                case 'Z':
                    mesh.position.z = -localBox.max.z; // Scale from the front side
                    break;
                case 'XY':
                    mesh.position.x = -localBox.max.x;
                    mesh.position.y = -localBox.max.y; // Scale from the top-right corner
                    break;
                case 'YZ':
                    mesh.position.y = -localBox.max.y;
                    mesh.position.z = -localBox.max.z; // Scale from the top-front corner
                    break;
                case 'XZ':
                    mesh.position.x = -localBox.max.x;
                    mesh.position.z = -localBox.max.z; // Scale from the front-right corner
                    break;
                case 'XYZ':
                    const center = localBox.getCenter(new THREE.Vector3());
                    mesh.position.set(-center.x, -center.y, -center.z); // Scale from the center
                    break;
                
                default:
                    // No adjustment needed for unrecognized axes
                    console.error("Unrecognized axes: ", axis);
                    break;
            }*/
    }
    private setBottomToolbarButton(id: string, state: boolean) {
        const btn: HTMLButtonElement | null = document.querySelector(`#${id}`);
        if (btn == null) {
            throw new Error(`Button with id ${id} not found in bottom toolbar`);
        }

        if (state) {
            if (btn.classList.contains("bottom-button-active") == false) {
                btn.classList.add("bottom-button-active");
            }
        } else {
            if (btn.classList.contains("bottom-button-active") == false) return;
            btn.classList.remove("bottom-button-active");
        }
    }
    private bottomToolbarButtonsInitialize() {
        const localSpaceButton: HTMLButtonElement | null =
            document.querySelector("#localspace");
        if (!localSpaceButton) return;



        localSpaceButton.addEventListener("click", () => {
            this.isLocalSpace = !this.isLocalSpace;
            this.setBottomToolbarButton("localspace", this.isLocalSpace);

            if (this.isLocalSpace) {
                this.arrowHelper.setSpace("local");
            } else {
                this.arrowHelper.setSpace("world");
            }
        });

        const resetPivotButton: HTMLButtonElement | null = document.querySelector("#resetPivot");
        if (!resetPivotButton) return;

        resetPivotButton.addEventListener("click", () => {
            if (this.currentSolidsSelected.length !== 1) return;
            this.resetPivot(this.currentSolidsSelected[0].getMesh());
        })

        const hideSolidsButton: HTMLButtonElement | null = document.querySelector("#hideSolids");
        if (!hideSolidsButton) return;
        hideSolidsButton.addEventListener("click", () => {
            for (const solid of this.currentSolidsSelected) {
                if (this.scene.getObjectById(solid.getMesh().id) == null) {
                    this.scene.add(solid.getMesh());
                    console.log("Add mesh");
                } else {
                    this.scene.remove(solid.getMesh());
                    console.log("Hide mesh");
                }

            }
            this.currentSolidsSelected = [];
            this.updateOutlinePass();
            this.determineArrowHelperState();
            this.updateTree();
        })

        const fastCSGButton: HTMLButtonElement | null = document.querySelector("#fastCSG");
        if (!fastCSGButton) return;
        fastCSGButton.addEventListener("click", () => {
            this.useFastCSG = !this.useFastCSG;
            this.setBottomToolbarButton("fastCSG", this.useFastCSG);
        });
        this.setBottomToolbarButton(`fastCSG`, this.useFastCSG);
    }
    private bottomToolbarButtonSetVisibility(id: string, visible: boolean) {
        const btn: HTMLButtonElement | null = document.querySelector(`#${id}`);
        if (btn == null) {
            throw new Error(`Invalid: ${id}`);
        }

        if (visible) {
            btn.style.display = "flex";
        } else {
            btn.style.display = "none";
        }
    }

    private initializeHelpers() {
        const gridHelper = new THREE.GridHelper(100, 200, 0x2E2C2C, 0x2E2C2C);
        this.scene.add(gridHelper);

        const gridHelperMajorLines = new THREE.GridHelper(
            100,
            200 / 10,
            0x666666,
            0x666666
        );
        this.scene.add(gridHelperMajorLines);

        const axisHelper = new THREE.AxesHelper(50);
        axisHelper.position.set(0, 0.01, 0);
        this.scene.add(axisHelper);

        this.arrowHelper = new TransformControls(
            this.camera,
            this.renderer.domElement
        );
        this.arrowHelper.setMode("translate");
        this.arrowHelper.setRotationSnap(degToRad(5));
        this.arrowHelper.setTranslationSnap(0.05);
        this.arrowHelper.setScaleSnap(0.05);
        this.arrowHelper.setSpace("local");
        this.scene.add(this.arrowHelper.getHelper());
        this.setBottomToolbarButton("localspace", true);
        this.bottomToolbarButtonSetVisibility("localspace", false);

        /*// On drag start, record the initial scale
        this.arrowHelper.addEventListener('mouseDown', () => {
            if (this.arrowHelper.mode !== "scale") return;
            this.scaleStart = this.arrowHelper.object.scale.clone();
            this.positionStart = this.arrowHelper.object.position.clone();
        });

        // On object change, apply repositioning hack
        this.arrowHelper.addEventListener('objectChange', () => {
            if (this.arrowHelper.mode !== "scale") return;
            const cube = this.arrowHelper.object;
            const _tempVector2 = cube.scale.clone().divide(this.scaleStart);
            cube.scale.copy(this.scaleStart).multiply(_tempVector2);

            const _box = new THREE.Box3().setFromObject(cube);
            const size = _box.getSize(new THREE.Vector3());

            // Compute new offset to simulate scaling from side
            const offset = new THREE.Vector3(size.x / 2, size.y / 2, size.z / 2);

            // Apply offset relative to original position
            cube.position.copy(this.positionStart).add(offset);
        });*/

        this.arrowHelper.addEventListener("objectChange", () => {
            if (this.currentSolidsSelected.length !== 1) return;
            this.updatePropertiesTab();


        })

    }
    private initializeStatistics() {
        //this.stats = new Stats();
        //document.body.appendChild(this.stats.dom);
    }

    private updateOutlinePass() {
        const a: THREE.Mesh[] = [];
        for (const solid of this.currentSolidsSelected) {
            a.push(solid.getMesh());
        }
        console.log(
            "OutlinePass: Updated total of ",
            this.currentSolidsSelected.length,
            " solids"
        );
        this.outlinePass.selectedObjects = a;
        this.updatePropertiesTab();
        const x: HTMLButtonElement | null = document.querySelector("#hideSolids");
        if (!x) return;
        if (a.length > 0) { x.style.display = "flex"; }
        else { x.style.display = "none" }
        const y: HTMLButtonElement | null = document.querySelector("#resetPivot");
        if (!y) return;
        if (a.length === 1) { y.style.display = "flex"; }
        else { y.style.display = "none"; }
    }
    private determineArrowHelperState() {
        const n = this.currentSolidsSelected.length;
        if (n === 1) {
            this.arrowHelperAttach(this.currentSolidsSelected[0]);
            this.arrowHelper.showX = true;
            this.arrowHelper.showY = true;
            this.arrowHelper.showZ = true;
            return;
        }

        if (n > 1) {
            // 1) Compute center position
            const center = new THREE.Vector3();
            // 2) Accumulate quaternions
            const avgQuat = new THREE.Quaternion();
            const tmpQuat = new THREE.Quaternion();

            for (const item of this.currentSolidsSelected) {
                const mesh = item.getMesh();
                mesh.updateMatrixWorld(true);

                // position
                center.add(mesh.getWorldPosition(new THREE.Vector3()));

                // orientation
                mesh.getWorldQuaternion(tmpQuat);
                avgQuat.x += tmpQuat.x;
                avgQuat.y += tmpQuat.y;
                avgQuat.z += tmpQuat.z;
                avgQuat.w += tmpQuat.w;
            }

            center.divideScalar(n);
            // normalize the summed quaternion to approximate the average
            avgQuat.normalize();

            // 3) Create group at center with averaged orientation
            this.arrowHelperGroup = new THREE.Group();
            this.arrowHelperGroup.position.copy(center);
            if (this.isLocalSpace) {
                this.arrowHelperGroup.quaternion.copy(avgQuat);
            }

            this.scene.add(this.arrowHelperGroup);

            // 4) Reparent meshes so they keep their world-space transforms
            for (const item of this.currentSolidsSelected) {
                const mesh = item.getMesh();
                mesh.updateMatrixWorld(true);

                if (this.scene.getObjectById(mesh.id)) {
                    this.scene.remove(mesh);
                    // `attach()` will compute the correct local position & rotation
                    this.arrowHelperGroup.attach(mesh);
                }
                // otherwise it was hidden—skip it
            }

            // 5) Hook up the gizmo
            this.arrowHelper.attach(this.arrowHelperGroup);
            this.bottomToolbarButtonSetVisibility("localspace", true);
            this.isMoving = true;
        } else {
            this.arrowHelperDetach();
        }
    }
    private onClick(event: MouseEvent) {
        if (event.button != 0) return;
        this.performRaycast();
        if (this.currentSolidFound == null) {
            console.error("No box hit");
            return;
        }
        if (this.isMoving == true && this.shiftHeldDown == false && this.altHeldDown == false) {
            console.error("Already moving");
            return;
        }

        if ((this.shiftHeldDown == true || this.altHeldDown == true) && this.currentSolidsSelected.length > 0) {
            if (
                this.currentSolidsSelected.indexOf(this.currentSolidFound) != -1 &&
                this.currentSolidsSelected.length > 1
            ) {
                // Remove from list
                /*console.log(this.currentSolidsSelected.indexOf(this.currentSolidFound));
                console.warn("Remove from list!");
                this.currentSolidsSelected.splice(
                    this.currentSolidsSelected.indexOf(this.currentSolidFound),
                    1
                );
                console.log(this.currentSolidsSelected.indexOf(this.currentSolidFound));*/
                const i = this.currentSolidsSelected.indexOf(this.currentSolidFound);
                if (i != -1) { this.currentSolidsSelected.splice(i, 1) }
                else {
                    this.currentSolidsSelected.push(this.currentSolidFound);
                }

                if (!this.altHeldDown) {
                    const parent = this.solidsTree[this.currentSolidFound.getMesh().uuid]?.parentId || "hahahaeeeeeeeeeeee";
                    this.selectAllDescendants(parent, this.currentSolidFound.getMesh().uuid);
                }

                this.determineArrowHelperState();
                this.isMoving = true;
                this.updateOutlinePass();
                this.updateTree();
                this.updatePropertiesTab();
                return;
            }
            this.currentSolidsSelected.push(this.currentSolidFound);
            if (!this.altHeldDown) {
                const parent = this.solidsTree[this.currentSolidFound.getMesh().uuid]?.parentId || "hahahaeeeeeeeeeeee";
                this.selectAllDescendants(parent, this.currentSolidFound.getMesh().uuid);
            }

            //this.arrowHelperDetach();
            this.isMoving = true;
            console.warn("Add to list");
            this.updateOutlinePass();
            this.updateTree();
            this.updatePropertiesTab();
            this.determineArrowHelperState();

            return;
        }

        /*this.arrowHelperAttach(this.currentSolidFound);
        this.currentSolidsSelected = [this.currentSolidFound];*/
        this.currentSolidsSelected.push(this.currentSolidFound);
        if (!this.altHeldDown) {
            const parent = this.solidsTree[this.currentSolidFound.getMesh().uuid]?.parentId || "hahahaeeeeeeeeeeee";
            this.selectAllDescendants(parent, this.currentSolidFound.getMesh().uuid);
        }

        this.determineArrowHelperState();
        this.isMoving = true;
        this.updateOutlinePass();

        const a = new THREE.Box3().setFromObject(this.currentSolidFound.getMesh());
        const size = new THREE.Vector3();
        a.getSize(size);

        this.previousSize.copy(size);
        console.log("Attached TransformControls to Box");
        this.updateTree();
        this.updatePropertiesTab();

    }
    private initializeMouseEvents() {
        document.addEventListener("mousemove", (event: MouseEvent) => {
            this.mouse.x = (event.clientX / window.innerWidth) * 2 - 1;
            this.mouse.y = -(event.clientY / window.innerHeight) * 2 + 1;
        });
        document.addEventListener("mousedown", (event: MouseEvent) => {
            // Arrow hlper
            if (this.isMoving) {
                this.getTransformControlsAxis();
            }
            this.onClick(event);
        });
    }
    private initializeKeyboardEvents() {
        document.addEventListener("keydown", (event: KeyboardEvent) => {
            if (event.key.toLowerCase() === "l") {
                event.preventDefault();
                this.isLocalSpace = !this.isLocalSpace;
                this.setBottomToolbarButton("localspace", this.isLocalSpace);
                if (this.isLocalSpace) { this.arrowHelper.setSpace("local") }
                else { this.arrowHelper.setSpace("world") }
                this.determineArrowHelperState();
            }
            if (event.key.toLowerCase() === "u") {
                this.useFastCSG = !this.useFastCSG;
                this.setBottomToolbarButton("fastCSG", this.useFastCSG);
            }
            if (event.key.toLowerCase() === 'P') {
                event.preventDefault();
                if (this.currentSolidsSelected.length != 1) return;
                this.resetPivot(this.currentSolidsSelected[0].getMesh());
            }
            if (event.altKey) {
                this.altHeldDown = true;
            }
            if (event.ctrlKey && event.key.toLowerCase() === "d") {
                event.preventDefault();
                this.addToUndoStack();

                console.log("Duplicating solids");
                const duplicated: Solid[] = [];

                if (this.arrowHelperGroup) {
                    // always pull world transforms directly from each mesh
                    for (const solid of this.currentSolidsSelected) {
                        const mesh = solid.getMesh();

                        // 1) read out world position / quaternion / scale
                        mesh.updateMatrixWorld(true);
                        const worldPos = mesh.getWorldPosition(new THREE.Vector3());
                        const worldQuat = mesh.getWorldQuaternion(new THREE.Quaternion());
                        const worldScale = mesh.getWorldScale(new THREE.Vector3());

                        // 2) clone the Solid and its mesh
                        const newSolid = solid.fullClone();
                        const newMesh = newSolid.getMesh();

                        // 3) apply world transforms to the clone
                        newMesh.position.copy(worldPos);
                        newMesh.quaternion.copy(worldQuat);
                        newMesh.scale.copy(worldScale);

                        // 4) add it into your scene & data structures
                        this.addSolid(newSolid, this.getParentOfSolid(solid));
                        duplicated.push(newSolid);
                    }
                } else {
                    // simple single-or-multiple duplication without a group
                    for (const solid of this.currentSolidsSelected) {
                        const newSolid = solid.fullClone();
                        duplicated.push(newSolid);
                        this.addSolid(newSolid, this.getParentOfSolid(solid));
                    }
                }

                // 7) update selection, outline, and gizmo
                this.currentSolidsSelected = duplicated;
                this.updateOutlinePass();
                this.determineArrowHelperState();

                return;
            }
            if (event.ctrlKey && event.key.toLowerCase() === "g") {
                event.preventDefault();
                if (this.currentSolidsSelected.length === 0) return;
                const first = this.currentSolidsSelected[0];
                const firstParent = this.solidsTree[first.getMesh().uuid].parentId;
                for (const other of this.currentSolidsSelected) {
                    if (this.solidsTree[other.getMesh().uuid].parentId != firstParent) {
                        console.error("Not all direct children");
                        return;
                    }
                }

                console.log("All direct children");

                const uuid = THREE.MathUtils.generateUUID();

                const group: FlatNode = {
                    id: uuid,
                    parentId: firstParent,
                    name: "group",
                    type: "group",
                };

                this.solidsTree[uuid] = group;

                for (const selected of this.currentSolidsSelected) {
                    this.solidsTree[selected.getMesh().uuid].parentId = uuid;
                }
                this.updateTree();
            }
            if (event.ctrlKey && event.key.toLowerCase() === "z") {
                event.preventDefault();
                return;
                console.log("Undo action!");
                this.undoAction();
            }
            if (event.ctrlKey && event.key.toLowerCase() === "a") {
                event.preventDefault();
                // Select everything
                this.currentSolidsSelected = [];
                for (const solidID in this.solids) {
                    const solid = this.solids[solidID];
                    this.currentSolidsSelected.push(solid);
                }
                this.updateOutlinePass();

                if (this.currentSolidsSelected.length === 1) {
                    this.arrowHelperAttach(this.currentSolidsSelected[0]);
                    this.isMoving = true;
                } else {
                    this.isMoving = true;
                    this.arrowHelperDetach();
                }
                this.updateTree();
            }
            if (event.key.toLowerCase() === 'v') {
                for (const solid of this.currentSolidsSelected) {
                    if (this.scene.getObjectById(solid.getMesh().id) == null) {
                        this.scene.add(solid.getMesh());
                        console.log("Add mesh");
                    } else {
                        this.scene.remove(solid.getMesh());
                        console.log("Hide mesh");
                    }

                }
                this.currentSolidsSelected = [];
                this.updateOutlinePass();
                this.determineArrowHelperState();
                this.updateTree();
            }
            if (event.key === "Escape") {
                if (this.isMoving == false) return;
                this.arrowHelperDetach();
                this.currentSolidsSelected = [];
                this.updateOutlinePass();
                this.isMoving = false;
                this.updateTree();
            }
            if (event.key === "2") {
                this.arrowHelper.setMode("translate");
            }
            if (event.key === "4") {
                this.arrowHelper.setMode("rotate");
            }
            if (event.key === "3") {
                this.arrowHelper.setMode("scale");
            }
            if (event.key === "Shift") {
                this.shiftHeldDown = true;
            }
            if (event.key === "Delete") {
                // de;ete
                this.addToUndoStack();
                this.arrowHelperDetach();
                for (const solid of this.currentSolidsSelected) {
                    //const a = this.solids.indexOf(solid);
                    const a = this.solids[solid.getMesh().uuid];
                    if (a !== null) {
                        //this.solids.splice(a, 1);
                        //this.scene.remove(solid.getMesh());
                        //solid.dispose();
                        this.deleteSolid(a);
                    }
                }
                this.currentSolidsSelected = [];
                this.isMoving = false;
            }
        });

        document.addEventListener("keyup", (event: KeyboardEvent) => {
            if (event.key === "Shift") {
                this.shiftHeldDown = false;
            }
            if (event.key === "Alt") {
                this.altHeldDown = false;
            }
        });
    }
    private initializeControlsEvents() {
        this.arrowHelper.addEventListener("change", () => {
            if (this.currentSolidsSelected.length !== 1) return;
            if (this.arrowHelper.mode !== "scale") {
                this.transformControlsAdjustPivot("XYZ");
                return;
            }
            console.log("Axis: ", this.arrowHelper.axis);
            this.transformControlsAdjustPivot(this.arrowHelper.axis);
        });
    }

    private CSG_operation(operation: "Union" | "Subtract" | "Intersect") {
        if (this.currentSolidsSelected.length != 2) {
            throw new Error("Invalid selected number of solids. Must be 2.");
        }

        const A = this.currentSolidsSelected[0];
        const B = this.currentSolidsSelected[1];

        //const indexOfB = this.solids.indexOf(B);
        //const indexOfA = this.solids.indexOf(A);

        let C!: Solid;
        if (operation == "Union") {
            C = A.CSG_union(B, this.useFastCSG);
        } else if (operation == "Subtract") {
            C = A.CSG_subtract(B, this.useFastCSG);
        } else if (operation == "Intersect") {
            C = A.CSG_intersect(B, this.useFastCSG);
        }
        // Remove the solid with the higher index first. Don't know how that fixes it. (May or may not fix actually, I don't know when the bug happens)
        /*if (indexOfA > indexOfB) {
                this.solids.splice(indexOfA, 1);
                this.solids.splice(indexOfB, 1);
            } else {
                this.solids.splice(indexOfB, 1);
                this.solids.splice(indexOfA, 1);
            }*/

        this.arrowHelperDetach();
        //this.scene.remove(A.getMesh());
        //this.scene.remove(B.getMesh());
        //this.solids.push(C);
        //this.scene.add(C.getMesh());
        this.addSolid(C, this.getParentOfSolid(A));
        this.deleteSolid(A);
        this.deleteSolid(B);

        this.currentSolidsSelected = [];
        this.updateOutlinePass();
        this.isMoving = false;

        console.log("*** COMPLETED CSG OPERATION ***");

        this.addToUndoStack();
    }
    private importScene(arrayBuffer: ArrayBuffer) {
        this.addToUndoStack();

        const uint8: Uint8Array = new Uint8Array(arrayBuffer);

        const decompressed: Uint8Array = inflateSync(uint8);
        const decoded: {
            solids: ExportedData[];
            tree: { [key: string]: FlatNode }
        } = decode(decompressed) as {
            solids: ExportedData[];
            tree: { [key: string]: FlatNode }
        };

        const solids = decoded.solids;
        const tree = decoded.tree;
        this.solidsTree = tree;

        const l = new THREE.ObjectLoader();
        for (const solid of solids) {
            const mesh = l.parse(solid.mesh) as THREE.Mesh;
            const newSolid = new Solid(mesh);
            newSolid.setHistoryAndParse(solid.history);
            newSolid.properties = solid.properties;
            this.solids[newSolid.getMesh().uuid] = newSolid;
            this.scene.add(newSolid.getMesh());
        }

        console.log("Loaded ", solids.length, " solids");
    }
    private initializeImportSceneEvent() {
        const inputFile: HTMLInputElement | null =
            document.querySelector("#importSceneInput");
        if (inputFile == null) return;

        inputFile.addEventListener("change", (event) => {
            if (!inputFile.files) return;
            const file = inputFile.files[0];
            const reader = new FileReader();
            reader.onload = () => {
                if (!reader.result) {
                    throw new Error("Reader did not return a result");
                }
                const result = reader.result as ArrayBuffer;

                inputFile.value = "";
                this.importScene(result);

                this.updateTree();
            };
            reader.readAsArrayBuffer(file);
        });
    }
    private exportScene() {
        const solidsExported = [];

        for (const solidID in this.solids) {
            const solid = this.solids[solidID];
            solidsExported.push(solid.export());
        }

        const finalDict = {
            solids: solidsExported,
            tree: this.solidsTree
        };

        const encoded: Uint8Array = encode(finalDict);
        const compressed: Uint8Array = deflateSync(encoded, { level: 9 });

        const blob = new Blob([compressed.buffer as ArrayBuffer], {
            type: "application/octet-stream",
        });
        const url = URL.createObjectURL(blob);

        const a = document.createElement("a");
        a.href = url;
        a.download = "3d_scene.tcc";
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    }
    private exportSceneAsSTL() {
        const scene = this.scene;
        const binary = true;
        // 1) Force every mesh to bake its world-transform into its geometry
        scene.updateMatrixWorld(true);

        // 2) Export only the meshes under a fresh Group
        const exportGroup = new THREE.Group();
        scene.traverse((child) => {
            if (
                (child as THREE.Mesh).isMesh &&
                !(child as any).isHelper &&
                child.type !== "Line" &&
                child.renderOrder !== Infinity &&
                child.type !== "TransformControlsPlane"
            ) {
                // bake world transform into the geometry
                console.log(child);
                const mesh = child.clone() as THREE.Mesh;
                mesh.geometry = mesh.geometry.clone().applyMatrix4(child.matrixWorld);
                mesh.position.set(0, 0, 0);
                mesh.rotation.set(0, 0, 0);
                mesh.scale.set(1, 1, 1);
                exportGroup.add(mesh);
            }
        });

        // 3) Generate STL
        const exporter = new STLExporter();
        const result = exporter.parse(exportGroup, { binary });

        // 4) Build a Blob and download
        let blob: Blob;
        if (true) {
            const dv = result as DataView;
            const { buffer, byteOffset, byteLength } = dv;
            const slice = buffer.slice(byteOffset, byteOffset + byteLength);
            blob = new Blob([slice as ArrayBuffer], {
                type: "application/octet-stream",
            });
        } else {
            //blob = new Blob([result as string], { type: 'text/plain' });
        }

        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = binary ? "scene.stl" : "scene_ascii.stl";
        a.click();
        URL.revokeObjectURL(url);
    }
    private attemptSeperate(solid: Solid) {
        if (solid.history.length == 0) {
            throw new Error("Solid has no history");
        }


        this.addToUndoStack();

        const originalSolid = solid;
        const SolidA = originalSolid.history[0].clone();
        const SolidB = originalSolid.history[1].clone();

        // Get the original matrices of the cloned solids from history
        const matrixAOriginal = SolidA.getMesh().matrix.clone();
        const matrixBOriginal = SolidB.getMesh().matrix.clone();

        // Get the current world matrix of the original solid being separated
        const matrixC = originalSolid.getMesh().matrixWorld.clone();

        // Compute new matrices by multiplying original matrices with the current matrixC
        const matrixANew = new THREE.Matrix4().multiplyMatrices(matrixC, matrixAOriginal);
        const matrixBNew = new THREE.Matrix4().multiplyMatrices(matrixC, matrixBOriginal);

        // Decompose the new matrices into position, rotation, and scale
        const positionA = new THREE.Vector3();
        const rotationA = new THREE.Quaternion();
        const scaleA = new THREE.Vector3();
        matrixANew.decompose(positionA, rotationA, scaleA);

        const positionB = new THREE.Vector3();
        const rotationB = new THREE.Quaternion();
        const scaleB = new THREE.Vector3();
        matrixBNew.decompose(positionB, rotationB, scaleB);

        // Apply the decomposed values to the cloned solids
        SolidA.getMesh().position.copy(positionA);
        SolidA.getMesh().rotation.setFromQuaternion(rotationA);
        SolidA.getMesh().scale.copy(scaleA);
        SolidA.updateProperties(); // Update properties to match new transform

        SolidB.getMesh().position.copy(positionB);
        SolidB.getMesh().rotation.setFromQuaternion(rotationB);
        SolidB.getMesh().scale.copy(scaleB);
        SolidB.updateProperties();

        this.arrowHelperDetach();
        this.scene.remove(originalSolid.getMesh());
        originalSolid.dispose();

        this.addSolid(SolidA, this.getParentOfSolid(originalSolid));
        this.addSolid(SolidB, this.getParentOfSolid(originalSolid));

        this.deleteSolid(originalSolid);

        this.currentSolidsSelected = [];
        this.updateOutlinePass();
        this.isMoving = false;
    }

    private importGroup(group: THREE.Group<THREE.Object3DEventMap>) {
        const meshes = getAllMeshes(group);

        for (const m of meshes) {
            m.material = new THREE.MeshPhysicalMaterial({ color: 0xffffff, flatShading: false });
            const s = new Solid(m);
            this.addSolid(s, null);
        }
        this.updateTree();
        console.log("Group import complete! Number of items: ", meshes.length);
    }

    private importMesh(mesh: THREE.Mesh) {
        mesh.material = new THREE.MeshPhysicalMaterial({ color: 0xffffff, flatShading: false });
        const s = new Solid(mesh);
        this.addSolid(s, null);
        this.updateTree();
        console.log("Mesh import complete!");
    }

    private resetPivot(mesh: THREE.Mesh) {
        // Compute geometry center
        const geometry = mesh.geometry;
        geometry.computeBoundingBox();
        const box = geometry.boundingBox;
        if (!box) return;
        const center = new THREE.Vector3();
        box.getCenter(center);

        // Shift geometry vertices so center becomes origin (pivot)
        geometry.translate(-center.x, -center.y, -center.z);

        // Move mesh position to compensate
        mesh.position.add(center);
    }

    private initializeImport3DbuttonEvent() {
        const importButton: HTMLButtonElement | null =
            document.querySelector("#import3D_import");
        if (!importButton) {
            throw new Error("Import3D import button not found");
        }
        const fileInput: HTMLInputElement | null =
            document.querySelector("#import3D_input");
        if (!fileInput) {
            throw new Error("no file input");
        }

        importButton.addEventListener("click", () => {
            const prompt: HTMLDivElement | null =
                document.querySelector("#import3D_prompt");
            if (!prompt) {
                throw new Error("Prompt tno found");
            }

            prompt.style.display = "none";
            if (fileInput.files == null) {
                console.error("No file inputs!");
                return;
            } // Should never happen?
            if (fileInput.files.length == 0) {
                console.error("Length = 0");
                return;
            }

            const file = fileInput.files[0];

            const name = file.name;
            const ext = name.substring(name.lastIndexOf(".") + 1).toLowerCase();
            console.log(ext);

            const reader = new FileReader();

            reader.onload = (e) => {
                if (e.target == null) {
                    console.error("No target");
                    return;
                }
                const buffer = e.target.result as ArrayBuffer;
                this.addToUndoStack();

                switch (ext.toLowerCase()) {
                    case "obj": {
                        console.log("Importing OBJ");
                        const text = new TextDecoder().decode(buffer);
                        const loader = new OBJLoader();
                        const object = loader.parse(text);
                        this.importGroup(object);
                        break;
                    }
                    case "fbx": {
                        console.log("Importing FBX");
                        const loader = new FBXLoader();
                        const object = loader.parse(buffer, "");
                        console.log(object);
                        this.importGroup(object);
                        break;
                    }
                    case "stl": {
                        console.log("Importing STL");
                        const loader = new STLLoader();
                        const geometry = loader.parse(buffer);
                        const material = new THREE.MeshPhysicalMaterial({ color: 0xffffff, flatShading: false });
                        const mesh = new THREE.Mesh(geometry, material);
                        this.importMesh(mesh);
                        break;
                    }
                    case "gltf":
                    case "glb": {
                        console.log("Importing GLTF / GLB");
                        const loader = new GLTFLoader();
                        loader.parse(
                            buffer,
                            "",
                            (gltf) => {
                                this.importGroup(gltf.scene);
                            },
                            (error) => {
                                console.error(error);
                                alert(error);
                            }
                        );
                        break;
                    }
                    default:
                        console.error("Unknown file extension");
                        console.warn("Unsupported file extension:", ext);
                        alert(`Unsupported file extension: ${ext}`);
                }
                //const loader = new GLTFLoader();
            };

            reader.readAsArrayBuffer(file);
        });
    }

    private initializeButtonEvents() {
        /* 
            Buttons: 
            <button id="union">Union</button>
            <button id="subtract">Subtract</button>
            <button id="intersect">Intersect</button>
            <button id="seperate">Seperate</button>
            */

        const unionButton: HTMLButtonElement | null =
            document.querySelector("#union");
        const subtractButton: HTMLButtonElement | null =
            document.querySelector("#subtract");
        const intersectButton: HTMLButtonElement | null =
            document.querySelector("#intersect");
        const seperateButton: HTMLButtonElement | null =
            document.querySelector("#seperate");

        if (
            unionButton == null ||
            subtractButton == null ||
            intersectButton == null ||
            seperateButton == null
        ) {
            throw new Error(
                "One or many essential buttons for element could not be found"
            );
        }

        unionButton.addEventListener("click", () => {
            this.CSG_operation("Union");
        });
        subtractButton.addEventListener("click", () => {
            this.CSG_operation("Subtract");
        });
        intersectButton.addEventListener("click", () => {
            this.CSG_operation("Intersect");
        });
        seperateButton.addEventListener("click", () => {
            if (this.currentSolidsSelected.length !== 1) {
                throw new Error("Selected solids not equal to 1");
            }
            this.attemptSeperate(this.currentSolidsSelected[0]);
        });

        // cube, sphere, cylinder, wedge

        const cubeButton: HTMLButtonElement | null =
            document.querySelector("#cube");
        const sphereButton: HTMLButtonElement | null =
            document.querySelector("#sphere");
        const CylinderButton: HTMLButtonElement | null =
            document.querySelector("#cylinder");
        const WedgeButton: HTMLButtonElement | null =
            document.querySelector("#wedge");

        if (
            cubeButton == null ||
            sphereButton == null ||
            CylinderButton == null ||
            WedgeButton == null
        )
            return;

        const material = new THREE.MeshPhysicalMaterial({ color: 0xffffff, flatShading: false });

        cubeButton.addEventListener("click", () => {
            // New cube!

            this.addToUndoStack();

            const geometry = new THREE.BoxGeometry(2, 2, 2);
            const mesh = new THREE.Mesh(geometry, material.clone());

            const solid = new Solid(mesh);
            this.addSolid(solid, null);
        });

        sphereButton.addEventListener("click", () => {
            // New cube!
            this.addToUndoStack();

            const geometry = new THREE.SphereGeometry(2);
            const mesh = new THREE.Mesh(geometry, material.clone());

            const solid = new Solid(mesh);
            this.addSolid(solid, null);
        });

        CylinderButton.addEventListener("click", () => {
            // New cube!
            this.addToUndoStack();

            const geometry = new THREE.CylinderGeometry(2, 2, 4);
            const mesh = new THREE.Mesh(geometry, material.clone());

            const solid = new Solid(mesh);
            this.addSolid(solid, null);
        });

        WedgeButton.addEventListener("click", () => {
            // New cube!
            this.addToUndoStack();

            const geometry = new THREE.DodecahedronGeometry(2, 0);
            const mesh = new THREE.Mesh(geometry, material.clone());

            const solid = new Solid(mesh);
            this.addSolid(solid, null);
        });

        const import3D_button: HTMLButtonElement | null =
            document.querySelector("#import3D");
        if (import3D_button == null) {
            throw new Error("where si import3d button");
        }

        const prompt: HTMLDivElement | null =
            document.querySelector("#import3D_prompt");
        if (!prompt) return;

        prompt.style.display = "none";

        import3D_button.addEventListener("click", () => {
            prompt.style.display = "block";
        });

        const exportScene: HTMLButtonElement | null =
            document.querySelector("#exportScene");
        const importScene: HTMLButtonElement | null =
            document.querySelector("#importScene");
        const exportSceneSTL: HTMLButtonElement | null =
            document.querySelector("#exportSceneSTL");

        if (exportScene == null || importScene == null || exportSceneSTL == null) {
            throw new Error("eeeeeeeeeee");
        }

        exportScene.addEventListener("click", () => {
            this.exportScene();
        });
        importScene.addEventListener("click", () => {
            const a: HTMLInputElement | null =
                document.querySelector("#importSceneInput");
            if (!a) return;
            a.click();
        });
        exportSceneSTL.addEventListener("click", () => {
            this.exportSceneAsSTL();
        });
    }
    private initializeDebugObjects() {

    }

    private getTransformControlsAxis() {
        this.raycaster.setFromCamera(this.mouse, this.camera);

        const intersects = this.raycaster.intersectObjects(
            this.arrowHelper.getHelper().children,
            true
        );

        if (intersects.length > 0) {
            const hit = intersects[0];
            const selectedAxis = hit.object.name; // "X", "Y", or "Z"

            const objPos = this.arrowHelper.getHelper().position;
            const point = hit.point;

            // Determine side (+ or -)
            //const axisDirection = Math.sign(point[selectedAxis.toLowerCase()] - objPos[selectedAxis.toLowerCase()]);
            const a = new THREE.Vector3();
            hit.object.getWorldDirection(a);
            console.log(`Direction:`, a);
            console.log(this.arrowHelper.getHelper().children);
        } else {
            console.warn("No selected axis");
        }
    }

    private selectAllDescendants(target: string, ignore: string) {
        console.log("Selecting all descendants");
        for (const nodeId in this.solidsTree) {

            const parent = this.solidsTree[nodeId].parentId;
            console.log("NodeID: ", nodeId, "// Target:", target, "// Parent: ", parent);
            if (parent == target && nodeId != ignore) {
                console.log("Found: ", nodeId);
                if (this.solidsTree[nodeId].type == "solid") {
                    if (this.currentSolidsSelected.indexOf(this.solids[nodeId]) == -1) {
                        this.currentSolidsSelected.push(this.solids[nodeId]);
                    } else {
                        this.currentSolidsSelected.splice(this.currentSolidsSelected.indexOf(this.solids[nodeId]), 1);
                    }

                } else if (this.solidsTree[nodeId].type == "group") {
                    this.selectAllDescendants(nodeId, "hahaeeeeeeeeeeeee");
                }

            }
        }
    }

    private performRaycast() {
        this.raycaster.setFromCamera(this.mouse, this.camera);

        const l: THREE.Mesh[] = [];
        for (const id in this.solids) {
            l.push(this.solids[id].getMesh());
        }

        const intersects = this.raycaster.intersectObjects(l, true); // true = recursive

        if (intersects.length > 0) {
            let valid = false;
            let foundBox: Solid | null = null;
            // Check if it is a valid object
            for (const intersect of intersects) {
                //console.log(intersect.object);
                if (valid == true && foundBox != null) {
                    break;
                }
                const hit = intersect.object;
                for (const boxID in this.solids) {
                    const box = this.solids[boxID];
                    if (box.getMesh() == hit && this.scene.getObjectById(box.getMesh().id) != null) {
                        valid = true;
                        foundBox = box;
                        break;
                    }
                }
            }

            if (valid == false || foundBox == null) {
                //console.log("Hit objects, but none were valid");
                this.outlinePass.selectedObjects = [];
                this.currentSolidFound = null;
                return;
            }
            //console.log("Raycasted box; Outline override box")

            this.currentSolidFound = foundBox;
            //this.outlinePass.selectedObjects = [foundBox.getMesh()];
        } else {
            if (this.isMoving) return;
            this.outlinePass.selectedObjects = [];
            this.currentSolidFound = null;
            //console.error("No hit; Outline disconnected");
        }
    }
    renderScene() {
        //this.stats.begin();
        this.controls.beforeRender(this.clock.getDelta() * 30);

        this.composer.render();
        //this.stats.end();
    }
    renderLoop() {
        requestAnimationFrame(this.renderLoop);
    }
}
