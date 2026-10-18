package extras.m2m;

import jakarta.persistence.Entity;
import jakarta.persistence.Id;
import jakarta.persistence.OneToMany;
import java.util.ArrayList;
import java.util.List;

@Entity
public class Team {
  @Id private Long id;

  // A one-to-many without mappedBy or @JoinColumn is stored in a join table.
  @OneToMany private List<Player> players = new ArrayList<>();
}
