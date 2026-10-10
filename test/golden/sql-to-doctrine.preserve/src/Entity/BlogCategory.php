<?php

declare(strict_types=1);

namespace App\Entity;

use DateTimeImmutable;
use Doctrine\Common\Collections\ArrayCollection;
use Doctrine\Common\Collections\Collection;
use Doctrine\ORM\Mapping as ORM;

#[ORM\Entity]
#[ORM\Table(name: 'blog_category')]
class BlogCategory
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

    #[ORM\Column(name: 'updated_at', type: 'datetimetz_immutable')]
    private DateTimeImmutable $updated_at;

    #[ORM\Column(name: 'name', type: 'string', length: 100, unique: true)]
    private string $name;

    #[ORM\Column(name: 'slug', type: 'string', length: 50)]
    private string $slug;

    #[ORM\ManyToOne(targetEntity: BlogCategory::class, inversedBy: 'blog_categories')]
    #[ORM\JoinColumn(
        name: 'parent_id',
        referencedColumnName: 'id',
        nullable: true,
        onDelete: 'SET NULL',
    )]
    private ?BlogCategory $parent = null;

    /** @var Collection<int, BlogCategory> */
    #[ORM\OneToMany(targetEntity: BlogCategory::class, mappedBy: 'parent')]
    private Collection $blog_categories;

    /** @var Collection<int, BlogPost> */
    #[ORM\OneToMany(targetEntity: BlogPost::class, mappedBy: 'category')]
    private Collection $blog_posts;

    public function __construct()
    {
        $this->created_at = new DateTimeImmutable();
        $this->blog_categories = new ArrayCollection();
        $this->blog_posts = new ArrayCollection();
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

    public function getParent(): ?BlogCategory
    {
        return $this->parent;
    }

    public function setParent(?BlogCategory $parent): static
    {
        $this->parent = $parent;

        return $this;
    }

    /**
     * @return Collection<int, BlogCategory>
     */
    public function getBlogCategories(): Collection
    {
        return $this->blog_categories;
    }

    public function addBlogCategory(BlogCategory $blogCategory): static
    {
        if (!$this->blog_categories->contains($blogCategory)) {
            $this->blog_categories->add($blogCategory);
            $blogCategory->setParent($this);
        }

        return $this;
    }

    public function removeBlogCategory(BlogCategory $blogCategory): static
    {
        if ($this->blog_categories->removeElement($blogCategory)) {
            if ($blogCategory->getParent() === $this) {
                $blogCategory->setParent(null);
            }
        }

        return $this;
    }

    /**
     * @return Collection<int, BlogPost>
     */
    public function getBlogPosts(): Collection
    {
        return $this->blog_posts;
    }

    public function addBlogPost(BlogPost $blogPost): static
    {
        if (!$this->blog_posts->contains($blogPost)) {
            $this->blog_posts->add($blogPost);
            $blogPost->setCategory($this);
        }

        return $this;
    }

    public function removeBlogPost(BlogPost $blogPost): static
    {
        if ($this->blog_posts->removeElement($blogPost)) {
            // The owning side is required, so it is not unset here.
        }

        return $this;
    }
}
