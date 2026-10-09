<?php

declare(strict_types=1);

namespace App\Entity;

use DateTimeImmutable;
use Doctrine\Common\Collections\ArrayCollection;
use Doctrine\Common\Collections\Collection;
use Doctrine\ORM\Mapping as ORM;

#[ORM\Entity]
#[ORM\Table(name: 'blog_category')]
#[ORM\HasLifecycleCallbacks]
class Category
{
    #[ORM\Id]
    #[ORM\GeneratedValue(strategy: 'AUTO')]
    #[ORM\Column(name: 'id', type: 'integer')]
    private ?int $id = null;

    #[ORM\Column(
        name: 'created_at',
        type: 'datetimetz_immutable',
        options: ['default' => 'CURRENT_TIMESTAMP'],
    )]
    private DateTimeImmutable $created_at;

    #[ORM\Column(
        name: 'updated_at',
        type: 'datetimetz_immutable',
        options: ['default' => 'CURRENT_TIMESTAMP'],
    )]
    private DateTimeImmutable $updated_at;

    #[ORM\Column(name: 'name', type: 'string', length: 100, unique: true)]
    private string $name;

    #[ORM\Column(name: 'slug', type: 'string', length: 50)]
    private string $slug;

    #[ORM\ManyToOne(targetEntity: Category::class, inversedBy: 'children')]
    #[ORM\JoinColumn(
        name: 'parent_id',
        referencedColumnName: 'id',
        nullable: true,
        onDelete: 'SET NULL',
    )]
    private ?Category $parent = null;

    /** @var Collection<int, Category> */
    #[ORM\OneToMany(targetEntity: Category::class, mappedBy: 'parent')]
    private Collection $children;

    /** @var Collection<int, Post> */
    #[ORM\OneToMany(targetEntity: Post::class, mappedBy: 'category')]
    private Collection $posts;

    public function __construct()
    {
        $this->created_at = new DateTimeImmutable();
        $this->updated_at = new DateTimeImmutable();
        $this->children = new ArrayCollection();
        $this->posts = new ArrayCollection();
    }

    public function getId(): ?int
    {
        return $this->id;
    }

    public function getCreatedAt(): DateTimeImmutable
    {
        return $this->created_at;
    }

    public function setCreatedAt(DateTimeImmutable $createdAt): static
    {
        $this->created_at = $createdAt;

        return $this;
    }

    public function getUpdatedAt(): DateTimeImmutable
    {
        return $this->updated_at;
    }

    public function setUpdatedAt(DateTimeImmutable $updatedAt): static
    {
        $this->updated_at = $updatedAt;

        return $this;
    }

    public function getName(): string
    {
        return $this->name;
    }

    public function setName(string $name): static
    {
        $this->name = $name;

        return $this;
    }

    public function getSlug(): string
    {
        return $this->slug;
    }

    public function setSlug(string $slug): static
    {
        $this->slug = $slug;

        return $this;
    }

    public function getParent(): ?Category
    {
        return $this->parent;
    }

    public function setParent(?Category $parent): static
    {
        $this->parent = $parent;

        return $this;
    }

    /**
     * @return Collection<int, Category>
     */
    public function getChildren(): Collection
    {
        return $this->children;
    }

    public function addChild(Category $child): static
    {
        if (!$this->children->contains($child)) {
            $this->children->add($child);
            $child->setParent($this);
        }

        return $this;
    }

    public function removeChild(Category $child): static
    {
        if ($this->children->removeElement($child)) {
            if ($child->getParent() === $this) {
                $child->setParent(null);
            }
        }

        return $this;
    }

    /**
     * @return Collection<int, Post>
     */
    public function getPosts(): Collection
    {
        return $this->posts;
    }

    public function addPost(Post $post): static
    {
        if (!$this->posts->contains($post)) {
            $this->posts->add($post);
            $post->setCategory($this);
        }

        return $this;
    }

    public function removePost(Post $post): static
    {
        if ($this->posts->removeElement($post)) {
            // The owning side is required, so it is not unset here.
        }

        return $this;
    }

    #[ORM\PrePersist]
    #[ORM\PreUpdate]
    public function refreshAutoUpdatedFields(): void
    {
        $this->updated_at = new DateTimeImmutable();
    }
}
