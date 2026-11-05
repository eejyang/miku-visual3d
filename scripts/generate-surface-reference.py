import vtk, json, hashlib, struct
from vtk.util.numpy_support import numpy_to_vtk, vtk_to_numpy
import numpy as np
cases = [
  ('single-boundary-voxel', [1,1,1], [1]),
  ('solid-anisotropic-box', [3,2,2], [2]*12),
  ('touching-labels', [3,3,3], [1 if x<1 else 2 if (y+z)%2 else 0 for z in range(3) for y in range(3) for x in range(3)]),
  ('checkerboard', [4,4,4], [(x+y+z)%2 for z in range(4) for y in range(4) for x in range(4)]),
  ('sparse-branch', [7,6,5], [8 if ((x==3 and y==2) or (z==2 and y==2 and x>0)) else 0 for z in range(5) for y in range(6) for x in range(7)]),
]
results=[]
for name,dims,labels in cases:
  dx,dy,dz=dims
  padded=np.pad(np.array(labels,dtype=np.uint32).reshape((dz,dy,dx)),1)
  image=vtk.vtkImageData(); image.SetDimensions(dx+2,dy+2,dz+2); image.SetOrigin(-1,-1,-1)
  image.GetPointData().SetScalars(numpy_to_vtk(padded.ravel(),deep=True))
  meshes=[]
  for label in sorted(set(labels)-{0}):
    fe=vtk.vtkDiscreteFlyingEdges3D(); fe.SetInputData(image); fe.SetValue(0,label); fe.Update()
    out=fe.GetOutput(); points=vtk_to_numpy(out.GetPoints().GetData())
    cell=vtk_to_numpy(out.GetPolys().GetConnectivityArray()).reshape((-1,3))
    triangles=[]
    for face in cell:
      p=sorted([','.join(str(int(round(v*2))) for v in points[i]) for i in face])
      triangles.append(';'.join(p))
    digest=hashlib.sha256('\n'.join(sorted(triangles)).encode()).hexdigest()
    meshes.append(dict(label=label,vertices=len(points),triangles=len(cell),sha256=digest))
  results.append(dict(name=name,dimensions=dims,labels=labels,meshes=meshes))
with open('test/fixtures/flying-edges-vtk.json','w') as f:
  json.dump(dict(vtk=vtk.vtkVersion.GetVTKVersion(),algorithm='vtkDiscreteFlyingEdges3D, zero padding, default settings',cases=results),f,indent=2)
print('Reference generated using VTK',vtk.vtkVersion.GetVTKVersion())
