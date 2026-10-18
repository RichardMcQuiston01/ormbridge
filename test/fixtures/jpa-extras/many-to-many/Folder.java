package extras.m2m;

import jakarta.persistence.Entity;
import jakarta.persistence.Id;
import jakarta.persistence.JoinColumn;
import jakarta.persistence.OneToMany;
import java.util.ArrayList;
import java.util.List;

@Entity
public class Folder {
  @Id private Long id;

  // A one-to-many with @JoinColumn puts the foreign key in the table of StoredFile.
  @OneToMany
  @JoinColumn(name = "folder_id")
  private List<StoredFile> files = new ArrayList<>();
}
