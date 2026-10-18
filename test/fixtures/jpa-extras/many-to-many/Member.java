package extras.m2m;

import jakarta.persistence.Entity;
import jakarta.persistence.Id;
import jakarta.persistence.JoinColumn;
import jakarta.persistence.JoinTable;
import jakarta.persistence.ManyToMany;
import java.util.HashSet;
import java.util.Set;

@Entity
public class Member {
  @Id private Long id;

  // A many-to-many to the same entity, with its own table and column names.
  @ManyToMany
  @JoinTable(
      name = "member_friends",
      joinColumns = @JoinColumn(name = "member_id"),
      inverseJoinColumns = @JoinColumn(name = "friend_id"))
  private Set<Member> friends = new HashSet<>();
}
