<?php

declare(strict_types=1);

namespace App\Entity;

use DateTimeImmutable;
use Doctrine\Common\Collections\ArrayCollection;
use Doctrine\Common\Collections\Collection;
use Doctrine\ORM\Mapping as ORM;

#[ORM\Entity]
#[ORM\Table(name: 'blog_user')]
#[ORM\HasLifecycleCallbacks]
class BlogUser
{
    #[ORM\Id]
    #[ORM\Column(name: 'id', type: 'guid')]
    private string $id;

    #[ORM\Column(
        name: 'created_at',
        type: 'datetimetz_immutable',
        options: ['default' => 'CURRENT_TIMESTAMP'],
    )]
    private DateTimeImmutable $createdAt;

    #[ORM\Column(name: 'updated_at', type: 'datetimetz_immutable')]
    private DateTimeImmutable $updatedAt;

    /** @var Collection<int, BlogPost> */
    #[ORM\OneToMany(targetEntity: BlogPost::class, mappedBy: 'author')]
    private Collection $authorBlogPosts;

    /** @var Collection<int, BlogPost> */
    #[ORM\OneToMany(targetEntity: BlogPost::class, mappedBy: 'editor')]
    private Collection $editorBlogPosts;

    #[ORM\OneToOne(targetEntity: BlogProfile::class, mappedBy: 'user')]
    private ?BlogProfile $blogProfile = null;

    public function __construct()
    {
        $this->id = self::generateUuid();
        $this->createdAt = new DateTimeImmutable();
        $this->authorBlogPosts = new ArrayCollection();
        $this->editorBlogPosts = new ArrayCollection();
    }

    public function getId(): string
    {
        return $this->id;
    }

    public function setId(string $id): static
    {
        $this->id = $id;

        return $this;
    }

    public function getCreatedAt(): DateTimeImmutable
    {
        return $this->createdAt;
    }

    public function setCreatedAt(DateTimeImmutable $createdAt): static
    {
        $this->createdAt = $createdAt;

        return $this;
    }

    public function getUpdatedAt(): DateTimeImmutable
    {
        return $this->updatedAt;
    }

    public function setUpdatedAt(DateTimeImmutable $updatedAt): static
    {
        $this->updatedAt = $updatedAt;

        return $this;
    }

    /**
     * @return Collection<int, BlogPost>
     */
    public function getAuthorBlogPosts(): Collection
    {
        return $this->authorBlogPosts;
    }

    public function addAuthorBlogPost(BlogPost $authorBlogPost): static
    {
        if (!$this->authorBlogPosts->contains($authorBlogPost)) {
            $this->authorBlogPosts->add($authorBlogPost);
            $authorBlogPost->setAuthor($this);
        }

        return $this;
    }

    public function removeAuthorBlogPost(BlogPost $authorBlogPost): static
    {
        if ($this->authorBlogPosts->removeElement($authorBlogPost)) {
            // The owning side is required, so it is not unset here.
        }

        return $this;
    }

    /**
     * @return Collection<int, BlogPost>
     */
    public function getEditorBlogPosts(): Collection
    {
        return $this->editorBlogPosts;
    }

    public function addEditorBlogPost(BlogPost $editorBlogPost): static
    {
        if (!$this->editorBlogPosts->contains($editorBlogPost)) {
            $this->editorBlogPosts->add($editorBlogPost);
            $editorBlogPost->setEditor($this);
        }

        return $this;
    }

    public function removeEditorBlogPost(BlogPost $editorBlogPost): static
    {
        if ($this->editorBlogPosts->removeElement($editorBlogPost)) {
            if ($editorBlogPost->getEditor() === $this) {
                $editorBlogPost->setEditor(null);
            }
        }

        return $this;
    }

    public function getBlogProfile(): ?BlogProfile
    {
        return $this->blogProfile;
    }

    public function setBlogProfile(?BlogProfile $blogProfile): static
    {
        $this->blogProfile = $blogProfile;
        if ($blogProfile !== null) {
            $blogProfile->setUser($this);
        }

        return $this;
    }

    #[ORM\PrePersist]
    #[ORM\PreUpdate]
    public function refreshAutoUpdatedFields(): void
    {
        $this->updatedAt = new DateTimeImmutable();
    }

    private static function generateUuid(): string
    {
        $bytes = random_bytes(16);
        $bytes[6] = chr((ord($bytes[6]) & 0x0f) | 0x40);
        $bytes[8] = chr((ord($bytes[8]) & 0x3f) | 0x80);

        return vsprintf('%s%s-%s-%s-%s-%s%s%s', str_split(bin2hex($bytes), 4));
    }
}
